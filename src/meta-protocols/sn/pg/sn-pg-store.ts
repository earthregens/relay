import { BasePgStoreModule, logger } from '@hirosystems/api-toolkit';
import * as postgres from 'postgres';
import { hexToBuffer } from '../../../api/util/helpers';
import {
  DbInscription,
  DbInscriptionIndexPaging,
  DbLocation,
  DbPaginatedResult,
} from '../../../pg/types';
import {
  SN_DEPLOYS_COLUMNS,
  SN_OPERATIONS,
  DbSnActivity,
  DbSnBalance,
  DbSnBalanceTypeId,
  DbSnDeployEvent,
  DbSnDeployInsert,
  DbSnEvent,
  DbSnEventOperation,
  DbSnHolder,
  DbSnLocation,
  DbSnMintEvent,
  DbSnScannedInscription,
  DbSnToken,
  DbSnTokenWithSupply,
  DbSnTransferEvent,
} from './types';

import {
  snDeploy,
  snMint,
  snTransfer,
  snFromInscriptionContent,
  isAddressSentAsFee,
} from './helpers';

import { snTokenOrderBy } from '../../../api/schemas';
import { objRemoveUndefinedValues } from '../../../pg/helpers';

export class snPgStore extends BasePgStoreModule {
  sqlOr(partials: postgres.PendingQuery<postgres.Row[]>[] | undefined) {
    return partials?.reduce((acc, curr) => this.sql`${acc} OR ${curr}`);
  }

  /**
   * Perform a scan of all inscriptions stored in the DB divided by block in order to look for
   * BRC-20 operations.
   * @param startBlock - Start at block height
   * @param endBlock - End at block height
   */
  async scanBlocks(startBlock: number, endBlock: number): Promise<void> {
    for (let blockHeight = startBlock; blockHeight <= endBlock; blockHeight++) {
      logger.info(`snPgStore scanning block ${blockHeight}`);
      await this.sqlWriteTransaction(async sql => {
        const block = await sql<DbSnScannedInscription[]>`
          SELECT
            EXISTS(SELECT location_id FROM genesis_locations WHERE location_id = l.id) AS genesis,
            l.id, l.inscription_id, l.block_height, l.tx_id, l.tx_index, l.address
          FROM locations AS l
          INNER JOIN inscriptions AS i ON l.inscription_id = i.id
          WHERE l.block_height = ${blockHeight}
            AND i.number >= 0
            AND i.mime_type IN ('application/json', 'text/plain')
          ORDER BY tx_index ASC
        `;
        await this.insertOperations(block);
      });
    }
  }

  async insertOperations(writes: DbSnScannedInscription[]): Promise<void> {
    if (writes.length === 0) return;
    for (const write of writes) {
      if (write.genesis) {
        if (isAddressSentAsFee(write.address)) continue;
        const content = await this.sql<{ content: string }[]>`
          SELECT content FROM inscriptions WHERE id = ${write.inscription_id}
        `;
        const sn = snFromInscriptionContent(
          hexToBuffer(content[0].content).toString('utf-8')
        );
        if (sn) {
          switch (sn.op) {
            case 'deploy':
              await this.insertDeploy({ op: sn, location: write });
              break;
            case 'mint':
              await this.insertMint({ op: sn, location: write });
              break;
            case 'transfer':
              await this.insertTransfer({ op: sn, location: write });
              break;
          }
        }
      } else {
        await this.applyTransfer(write);
      }
    }
  }

  async applyTransfer(location: DbSnScannedInscription): Promise<void> {
    await this.sqlWriteTransaction(async sql => {
      if (!location.inscription_id) return;
      // Get the sender address for this transfer. We need to get this in a separate query to know
      // if we should alter the write query to accomodate a "return to sender" scenario.
      const fromAddressRes = await sql<{ from_address: string }[]>`
        SELECT from_address FROM sn_transfers WHERE inscription_id = ${location.inscription_id}
      `;
      if (fromAddressRes.count === 0) return;
      const fromAddress = fromAddressRes[0].from_address;
      // Is this transfer sent as fee or from the same sender? If so, we'll return the balance.
      const returnToSender =
        isAddressSentAsFee(location.address) || fromAddress == location.address;
      const toAddress = returnToSender ? fromAddress : location.address;
      // Check if we have a valid transfer inscription emitted by this address that hasn't been sent
      // to another address before. Use `LIMIT 3` as a quick way of checking if we have just inserted
      // the first transfer for this inscription (genesis + transfer).
      const sendRes = await sql`
        WITH transfer_data AS (
          SELECT t.id, t.amount, t.sn_deploy_id, t.from_address, ROW_NUMBER() OVER()
          FROM locations AS l
          INNER JOIN sn_transfers AS t ON t.inscription_id = l.inscription_id
          WHERE l.inscription_id = ${location.inscription_id}
            AND (
              l.block_height < ${location.block_height}
              OR (l.block_height = ${location.block_height} AND l.tx_index <= ${location.tx_index})
            )
          LIMIT 3
        ),
        validated_transfer AS (
          SELECT * FROM transfer_data
          WHERE NOT EXISTS(SELECT id FROM transfer_data WHERE row_number = 3)
          LIMIT 1
        ),
        updated_transfer AS (
          UPDATE sn_transfers
          SET to_address = ${toAddress}
          WHERE id = (SELECT id FROM validated_transfer)
        ),
        balance_insert_from AS (
          INSERT INTO sn_balances (inscription_id, location_id, sn_deploy_id, address, avail_balance, trans_balance, type) (
            SELECT ${location.inscription_id}, ${location.id}, sn_deploy_id, from_address, 0,
              -1 * amount, ${DbSnBalanceTypeId.transferFrom}
            FROM validated_transfer
          )
          ON CONFLICT ON CONSTRAINT sn_balances_inscription_id_type_unique DO NOTHING
        ),
        balance_insert_to AS (
          INSERT INTO sn_balances (inscription_id, location_id, sn_deploy_id, address, avail_balance, trans_balance, type) (
            SELECT ${location.inscription_id}, ${location.id}, sn_deploy_id, ${toAddress},
              amount, 0, ${DbSnBalanceTypeId.transferTo}
            FROM validated_transfer
          )
          ON CONFLICT ON CONSTRAINT sn_balances_inscription_id_type_unique DO NOTHING
        ),
        ${
          returnToSender
            ? sql`
                total_balance_revert AS (
                  UPDATE sn_total_balances SET
                    avail_balance = avail_balance + (SELECT amount FROM validated_transfer),
                    trans_balance = trans_balance - (SELECT amount FROM validated_transfer)
                  WHERE sn_deploy_id = (SELECT sn_deploy_id FROM validated_transfer)
                    AND address = (SELECT from_address FROM validated_transfer)
                ),
                address_event_type_count_increase AS (
                  INSERT INTO sn_counts_by_address_event_type (address, transfer_send)
                  (SELECT from_address, 1 FROM validated_transfer)
                  ON CONFLICT (address) DO UPDATE SET transfer_send = sn_counts_by_address_event_type.transfer_send + EXCLUDED.transfer_send
                )
              `
            : sql`
                total_balance_insert_from AS (
                  UPDATE sn_total_balances SET
                    trans_balance = trans_balance - (SELECT amount FROM validated_transfer),
                    total_balance = total_balance - (SELECT amount FROM validated_transfer)
                  WHERE sn_deploy_id = (SELECT sn_deploy_id FROM validated_transfer)
                    AND address = (SELECT from_address FROM validated_transfer)
                ),
                total_balance_insert_to AS (
                  INSERT INTO sn_total_balances (sn_deploy_id, address, avail_balance, trans_balance, total_balance) (
                    SELECT sn_deploy_id, ${toAddress}, amount, 0, amount
                    FROM validated_transfer
                  )
                  ON CONFLICT ON CONSTRAINT sn_total_balances_unique DO UPDATE SET
                    avail_balance = sn_total_balances.avail_balance + EXCLUDED.avail_balance,
                    total_balance = sn_total_balances.total_balance + EXCLUDED.total_balance
                ),
                address_event_type_count_increase_from AS (
                  INSERT INTO sn_counts_by_address_event_type (address, transfer_send)
                  (SELECT from_address, 1 FROM validated_transfer)
                  ON CONFLICT (address) DO UPDATE SET transfer_send = sn_counts_by_address_event_type.transfer_send + EXCLUDED.transfer_send
                ),
                address_event_type_count_increase_to AS (
                  INSERT INTO sn_counts_by_address_event_type (address, transfer_send)
                  (SELECT ${toAddress}, 1 FROM validated_transfer)
                  ON CONFLICT (address) DO UPDATE SET transfer_send = sn_counts_by_address_event_type.transfer_send + EXCLUDED.transfer_send
                )
              `
        }, deploy_update AS (
          UPDATE sn_deploys
          SET tx_count = tx_count + 1
          WHERE id = (SELECT sn_deploy_id FROM validated_transfer)
        ),
        event_type_count_increase AS (
          INSERT INTO sn_counts_by_event_type (event_type, count)
          (SELECT 'transfer_send', COALESCE(COUNT(*), 0) FROM validated_transfer)
          ON CONFLICT (event_type) DO UPDATE SET count = sn_counts_by_event_type.count + EXCLUDED.count
        )
        INSERT INTO sn_events (operation, inscription_id, genesis_location_id, sn_deploy_id, transfer_id, address, from_address) (
          SELECT 'transfer_send', ${location.inscription_id}, ${location.id}, sn_deploy_id, id,
            ${location.address}, from_address
          FROM validated_transfer
        )
      `;
      if (sendRes.count)
        logger.info(`snPgStore send transfer to ${toAddress} at block ${location.block_height}`);
    });
  }

  private async insertDeploy(deploy: {
    op: snDeploy;
    location: DbSnLocation;
  }): Promise<void> {
    if (!deploy.location.inscription_id || isAddressSentAsFee(deploy.location.address)) return;
    const insert: DbSnDeployInsert = {
      inscription_id: deploy.location.inscription_id,
      block_height: deploy.location.block_height,
      tx_id: deploy.location.tx_id,
      address: deploy.location.address as string,
      ticker: deploy.op.tick,
      max: deploy.op.max,
      limit: deploy.op.lim ?? null,
      decimals: deploy.op.dec ?? '18',
      tx_count: 1,
    };
    const deployRes = await this.sql`
      WITH deploy_insert AS (
        INSERT INTO sn_deploys ${this.sql(insert)}
        ON CONFLICT (LOWER(ticker)) DO NOTHING
        RETURNING id
      ),
      event_type_count_increase AS (
        INSERT INTO sn_counts_by_event_type (event_type, count)
        (SELECT 'deploy', COALESCE(COUNT(*), 0) FROM deploy_insert)
        ON CONFLICT (event_type) DO UPDATE SET count = sn_counts_by_event_type.count + EXCLUDED.count
      ),
      address_event_type_count_increase AS (
        INSERT INTO sn_counts_by_address_event_type (address, deploy)
        (SELECT ${deploy.location.address}, COALESCE(COUNT(*), 0) FROM deploy_insert)
        ON CONFLICT (address) DO UPDATE SET deploy = sn_counts_by_address_event_type.deploy + EXCLUDED.deploy
      ),
      token_count_increase AS (
        INSERT INTO sn_counts_by_tokens (token_type, count)
        (SELECT 'token', COALESCE(COUNT(*), 0) FROM deploy_insert)
        ON CONFLICT (token_type) DO UPDATE SET count = sn_counts_by_tokens.count + EXCLUDED.count
      )
      INSERT INTO sn_events (operation, inscription_id, genesis_location_id, sn_deploy_id, deploy_id, address) (
        SELECT 'deploy', ${deploy.location.inscription_id}, ${deploy.location.id}, id, id,
          ${deploy.location.address}
        FROM deploy_insert
      )
    `;
    if (deployRes.count)
      logger.info(
        `snPgStore deploy ${deploy.op.tick} by ${deploy.location.address} at block ${deploy.location.block_height}`
      );
  }

  private async insertMint(mint: { op: snMint; location: DbSnLocation }): Promise<void> {
    if (!mint.location.inscription_id || isAddressSentAsFee(mint.location.address)) return;
    // Check the following conditions:
    // * Is the mint amount within the allowed token limits?
    // * Is the number of decimals correct?
    // * Does the mint amount exceed remaining supply?
    const mintRes = await this.sql`
      WITH mint_data AS (
        SELECT id, decimals, "limit", max, minted_supply
        FROM sn_deploys
        WHERE ticker_lower = LOWER(${mint.op.tick}) AND minted_supply < max
      ),
      validated_mint AS (
        SELECT
          id AS sn_deploy_id,
          LEAST(${mint.op.amt}::numeric, max - minted_supply) AS real_mint_amount
        FROM mint_data
        WHERE ("limit" IS NULL OR ${mint.op.amt}::numeric <= "limit")
          AND (SCALE(${mint.op.amt}::numeric) <= decimals)
      ),
      mint_insert AS (
        INSERT INTO sn_mints (inscription_id, sn_deploy_id, block_height, tx_id, address, amount) (
          SELECT ${mint.location.inscription_id}, sn_deploy_id, ${mint.location.block_height},
            ${mint.location.tx_id}, ${mint.location.address}, ${mint.op.amt}::numeric
          FROM validated_mint
        )
        ON CONFLICT (inscription_id) DO NOTHING
        RETURNING id, sn_deploy_id
      ),
      deploy_update AS (
        UPDATE sn_deploys
        SET
          minted_supply = minted_supply + (SELECT real_mint_amount FROM validated_mint),
          tx_count = tx_count + 1
        WHERE id = (SELECT sn_deploy_id FROM validated_mint)
      ),
      balance_insert AS (
        INSERT INTO sn_balances (inscription_id, location_id, sn_deploy_id, address, avail_balance, trans_balance, type) (
          SELECT ${mint.location.inscription_id}, ${mint.location.id}, sn_deploy_id,
            ${mint.location.address}, real_mint_amount, 0, ${DbSnBalanceTypeId.mint}
          FROM validated_mint
        )
        ON CONFLICT ON CONSTRAINT sn_balances_inscription_id_type_unique DO NOTHING
      ),
      total_balance_insert AS (
        INSERT INTO sn_total_balances (sn_deploy_id, address, avail_balance, trans_balance, total_balance) (
          SELECT sn_deploy_id, ${mint.location.address}, real_mint_amount, 0, real_mint_amount
          FROM validated_mint
        )
        ON CONFLICT ON CONSTRAINT sn_total_balances_unique DO UPDATE SET
          avail_balance = sn_total_balances.avail_balance + EXCLUDED.avail_balance,
          total_balance = sn_total_balances.total_balance + EXCLUDED.total_balance
      ),
      event_type_count_increase AS (
        INSERT INTO sn_counts_by_event_type (event_type, count)
        (SELECT 'mint', COALESCE(COUNT(*), 0) FROM validated_mint)
        ON CONFLICT (event_type) DO UPDATE SET count = sn_counts_by_event_type.count + EXCLUDED.count
      ),
      address_event_type_count_increase AS (
        INSERT INTO sn_counts_by_address_event_type (address, mint)
        (SELECT ${mint.location.address}, COALESCE(COUNT(*), 0) FROM validated_mint)
        ON CONFLICT (address) DO UPDATE SET mint = sn_counts_by_address_event_type.mint + EXCLUDED.mint
      )
      INSERT INTO sn_events (operation, inscription_id, genesis_location_id, sn_deploy_id, mint_id, address) (
        SELECT 'mint', ${mint.location.inscription_id}, ${mint.location.id}, sn_deploy_id, id, ${mint.location.address}
        FROM mint_insert
      )
    `;
    if (mintRes.count)
      logger.info(
        `snPgStore mint ${mint.op.tick} (${mint.op.amt}) by ${mint.location.address} at block ${mint.location.block_height}`
      );
  }

  private async insertTransfer(transfer: {
    op: snTransfer;
    location: DbSnLocation;
  }): Promise<void> {
    if (!transfer.location.inscription_id || isAddressSentAsFee(transfer.location.address)) return;
    // Check the following conditions:
    // * Do we have enough available balance to do this transfer?
    const transferRes = await this.sql`
      WITH balance_data AS (
        SELECT b.sn_deploy_id, COALESCE(SUM(b.avail_balance), 0) AS avail_balance
        FROM sn_balances AS b
        INNER JOIN sn_deploys AS d ON b.sn_deploy_id = d.id
        WHERE d.ticker_lower = LOWER(${transfer.op.tick})
          AND b.address = ${transfer.location.address}
        GROUP BY b.sn_deploy_id
      ),
      validated_transfer AS (
        SELECT * FROM balance_data
        WHERE avail_balance >= ${transfer.op.amt}::numeric
      ),
      transfer_insert AS (
        INSERT INTO sn_transfers (inscription_id, sn_deploy_id, block_height, tx_id, from_address, to_address, amount) (
          SELECT ${transfer.location.inscription_id}, sn_deploy_id,
            ${transfer.location.block_height}, ${transfer.location.tx_id},
            ${transfer.location.address}, NULL, ${transfer.op.amt}::numeric
          FROM validated_transfer
        )
        ON CONFLICT (inscription_id) DO NOTHING
        RETURNING id, sn_deploy_id
      ),
      balance_insert AS (
        INSERT INTO sn_balances (inscription_id, location_id, sn_deploy_id, address, avail_balance, trans_balance, type) (
          SELECT ${transfer.location.inscription_id}, ${transfer.location.id}, sn_deploy_id,
            ${transfer.location.address}, -1 * ${transfer.op.amt}::numeric,
            ${transfer.op.amt}::numeric, ${DbSnBalanceTypeId.transferIntent}
          FROM validated_transfer
        )
        ON CONFLICT ON CONSTRAINT sn_balances_inscription_id_type_unique DO NOTHING
      ),
      total_balance_update AS (
        UPDATE sn_total_balances SET
          avail_balance = avail_balance - ${transfer.op.amt}::numeric,
          trans_balance = trans_balance + ${transfer.op.amt}::numeric
        WHERE sn_deploy_id = (SELECT sn_deploy_id FROM validated_transfer)
          AND address = ${transfer.location.address}
      ),
      deploy_update AS (
        UPDATE sn_deploys
        SET tx_count = tx_count + 1
        WHERE id = (SELECT sn_deploy_id FROM validated_transfer)
      ),
      event_type_count_increase AS (
        INSERT INTO sn_counts_by_event_type (event_type, count)
        (SELECT 'transfer', COALESCE(COUNT(*), 0) FROM validated_transfer)
        ON CONFLICT (event_type) DO UPDATE SET count = sn_counts_by_event_type.count + EXCLUDED.count
      ),
      address_event_type_count_increase AS (
        INSERT INTO sn_counts_by_address_event_type (address, transfer)
        (SELECT ${transfer.location.address}, COALESCE(COUNT(*), 0) FROM validated_transfer)
        ON CONFLICT (address) DO UPDATE SET transfer = sn_counts_by_address_event_type.transfer + EXCLUDED.transfer
      )
      INSERT INTO sn_events (operation, inscription_id, genesis_location_id, sn_deploy_id, transfer_id, address) (
        SELECT 'transfer', ${transfer.location.inscription_id}, ${transfer.location.id}, sn_deploy_id, id, ${transfer.location.address}
        FROM transfer_insert
      )
    `;
    if (transferRes.count)
      logger.info(
        `snPgStore transfer ${transfer.op.tick} (${transfer.op.amt}) by ${transfer.location.address} at block ${transfer.location.block_height}`
      );
  }

  async rollBackInscription(args: { inscription: DbInscription }): Promise<void> {
    const events = await this.sql<DbSnEvent[]>`
      SELECT * FROM sn_events WHERE inscription_id = ${args.inscription.id}
    `;
    if (events.count === 0) return;
    // Traverse all activities generated by this inscription and roll back actions that are NOT
    // otherwise handled by the ON DELETE CASCADE postgres constraint.
    for (const event of events) {
      switch (event.operation) {
        case 'deploy':
          await this.rollBackDeploy(event);
          break;
        case 'mint':
          await this.rollBackMint(event);
          break;
        case 'transfer':
          await this.rollBackTransfer(event);
          break;
      }
    }
  }

  async rollBackLocation(args: { location: DbLocation }): Promise<void> {
    const events = await this.sql<DbSnEvent[]>`
      SELECT * FROM sn_events WHERE genesis_location_id = ${args.location.id}
    `;
    if (events.count === 0) return;
    // Traverse all activities generated by this location and roll back actions that are NOT
    // otherwise handled by the ON DELETE CASCADE postgres constraint.
    for (const event of events) {
      switch (event.operation) {
        case 'transfer_send':
          await this.rollBackTransferSend(event);
          break;
      }
    }
  }

  private async rollBackDeploy(activity: DbSnDeployEvent): Promise<void> {
    // - tx_count is lost successfully, since the deploy will be deleted.
    await this.sql`
      WITH decrease_event_count AS (
        UPDATE sn_counts_by_event_type
        SET count = count - 1
        WHERE event_type = 'deploy'
      ),
      decrease_address_event_count AS (
        UPDATE sn_counts_by_address_event_type
        SET deploy = deploy - 1
        WHERE address = (SELECT address FROM locations WHERE id = ${activity.genesis_location_id})
      )
      UPDATE sn_counts_by_tokens
      SET count = count - 1
    `;
  }

  private async rollBackMint(activity: DbSnMintEvent): Promise<void> {
    // Get real minted amount and substract from places.
    await this.sql`
      WITH minted_balance AS (
        SELECT address, avail_balance
        FROM sn_balances
        WHERE inscription_id = ${activity.inscription_id} AND type = ${DbSnBalanceTypeId.mint}
      ),
      deploy_update AS (
        UPDATE sn_deploys
        SET
          minted_supply = minted_supply - (SELECT avail_balance FROM minted_balance),
          tx_count = tx_count - 1
        WHERE id = ${activity.sn_deploy_id}
      ),
      decrease_event_count AS (
        UPDATE sn_counts_by_event_type
        SET count = count - 1
        WHERE event_type = 'mint'
      ),
      decrease_address_event_count AS (
        UPDATE sn_counts_by_address_event_type
        SET mint = mint - 1
        WHERE address = (SELECT address FROM locations WHERE id = ${activity.genesis_location_id})
      )
      UPDATE sn_total_balances SET
        avail_balance = avail_balance - (SELECT avail_balance FROM minted_balance),
        total_balance = total_balance - (SELECT avail_balance FROM minted_balance)
      WHERE address = (SELECT address FROM minted_balance)
        AND sn_deploy_id = ${activity.sn_deploy_id}
    `;
  }

  private async rollBackTransfer(activity: DbSnTransferEvent): Promise<void> {
    // Subtract tx_count per transfer event (transfer and transfer_send are
    // separate events, so they will both be counted).
    await this.sql`
      WITH transferrable_balance AS (
        SELECT address, trans_balance
        FROM sn_balances
        WHERE inscription_id = ${activity.inscription_id} AND type = ${DbSnBalanceTypeId.transferIntent}
      ),
      decrease_event_count AS (
        UPDATE sn_counts_by_event_type
        SET count = count - 1
        WHERE event_type = 'transfer'
      ),
      decrease_address_event_count AS (
        UPDATE sn_counts_by_address_event_type
        SET transfer = transfer - 1
        WHERE address = (SELECT address FROM locations WHERE id = ${activity.genesis_location_id})
      ),
      decrease_tx_count AS (
        UPDATE sn_deploys
        SET tx_count = tx_count - 1
        WHERE id = ${activity.sn_deploy_id}
      )
      UPDATE sn_total_balances SET
        trans_balance = trans_balance - (SELECT trans_balance FROM transferrable_balance),
        avail_balance = avail_balance + (SELECT trans_balance FROM transferrable_balance)
      WHERE address = (SELECT address FROM transferrable_balance)
        AND sn_deploy_id = ${activity.sn_deploy_id}
    `;
  }

  private async rollBackTransferSend(activity: DbSnTransferEvent): Promise<void> {
    await this.sqlWriteTransaction(async sql => {
      // Get the sender/receiver address for this transfer. We need to get this in a separate query
      // to know if we should alter the write query to accomodate a "return to sender" scenario.
      const addressRes = await sql<{ returned_to_sender: boolean }[]>`
        SELECT from_address = to_address AS returned_to_sender
        FROM sn_transfers
        WHERE inscription_id = ${activity.inscription_id}
      `;
      if (addressRes.count === 0) return;
      const returnedToSender = addressRes[0].returned_to_sender;
      await sql`
        WITH sent_balance_from AS (
          SELECT address, trans_balance
          FROM sn_balances
          WHERE inscription_id = ${activity.inscription_id}
          AND type = ${DbSnBalanceTypeId.transferFrom}
        ),
        sent_balance_to AS (
          SELECT address, avail_balance
          FROM sn_balances
          WHERE inscription_id = ${activity.inscription_id}
          AND type = ${DbSnBalanceTypeId.transferTo}
        ),
        decrease_event_count AS (
          UPDATE sn_counts_by_event_type
          SET count = count - 1
          WHERE event_type = 'transfer_send'
        ),
        ${
          returnedToSender
            ? sql`
                decrease_address_event_count AS (
                  UPDATE sn_counts_by_address_event_type
                  SET transfer_send = transfer_send - 1
                  WHERE address = (SELECT address FROM sent_balance_from)
                ),
                undo_sent_balance AS (
                  UPDATE sn_total_balances SET
                    trans_balance = trans_balance - (SELECT trans_balance FROM sent_balance_from),
                    avail_balance = avail_balance + (SELECT trans_balance FROM sent_balance_from)
                  WHERE address = (SELECT address FROM sent_balance_from)
                    AND sn_deploy_id = ${activity.sn_deploy_id}
                )
              `
            : sql`
                decrease_address_event_count_from AS (
                  UPDATE sn_counts_by_address_event_type
                  SET transfer_send = transfer_send - 1
                  WHERE address = (SELECT address FROM sent_balance_from)
                ),
                decrease_address_event_count_to AS (
                  UPDATE sn_counts_by_address_event_type
                  SET transfer_send = transfer_send - 1
                  WHERE address = (SELECT address FROM sent_balance_to)
                ),
                undo_sent_balance_from AS (
                  UPDATE sn_total_balances SET
                    trans_balance = trans_balance - (SELECT trans_balance FROM sent_balance_from),
                    total_balance = total_balance - (SELECT trans_balance FROM sent_balance_from)
                  WHERE address = (SELECT address FROM sent_balance_from)
                    AND sn_deploy_id = ${activity.sn_deploy_id}
                ),
                undo_sent_balance_to AS (
                  UPDATE sn_total_balances SET
                    avail_balance = avail_balance - (SELECT avail_balance FROM sent_balance_to),
                    total_balance = total_balance - (SELECT avail_balance FROM sent_balance_to)
                  WHERE address = (SELECT address FROM sent_balance_to)
                    AND sn_deploy_id = ${activity.sn_deploy_id}
                )
              `
        }
        UPDATE sn_deploys
        SET tx_count = tx_count - 1
        WHERE id = ${activity.sn_deploy_id}
      `;
    });
  }

  async getTokens(
    args: { ticker?: string[]; order_by?: snTokenOrderBy } & DbInscriptionIndexPaging
  ): Promise<DbPaginatedResult<DbSnToken>> {
    const tickerPrefixCondition = this.sqlOr(
      args.ticker?.map(t => this.sql`d.ticker_lower LIKE LOWER(${t}) || '%'`)
    );
    const orderBy =
      args.order_by === snTokenOrderBy.tx_count
        ? this.sql`tx_count DESC` // tx_count
        : this.sql`l.block_height DESC, l.tx_index DESC`; // default: `index`
    const results = await this.sql<(DbSnToken & { total: number })[]>`
      ${
        args.ticker === undefined
          ? this.sql`WITH global_count AS (
              SELECT COALESCE(count, 0) AS count FROM sn_counts_by_tokens
            )`
          : this.sql``
      }
      SELECT
        ${this.sql(SN_DEPLOYS_COLUMNS.map(c => `d.${c}`))},
        i.number, i.genesis_id, l.timestamp,
        ${
          args.ticker ? this.sql`COUNT(*) OVER()` : this.sql`(SELECT count FROM global_count)`
        } AS total
      FROM sn_deploys AS d
      INNER JOIN inscriptions AS i ON i.id = d.inscription_id
      INNER JOIN genesis_locations AS g ON g.inscription_id = d.inscription_id
      INNER JOIN locations AS l ON l.id = g.location_id
      ${tickerPrefixCondition ? this.sql`WHERE ${tickerPrefixCondition}` : this.sql``}
      ORDER BY ${orderBy}
      OFFSET ${args.offset}
      LIMIT ${args.limit}
    `;
    return {
      total: results[0]?.total ?? 0,
      results: results ?? [],
    };
  }

  async getBalances(
    args: {
      address: string;
      ticker?: string[];
      block_height?: number;
    } & DbInscriptionIndexPaging
  ): Promise<DbPaginatedResult<DbSnBalance>> {
    const ticker = this.sqlOr(
      args.ticker?.map(t => this.sql`d.ticker_lower LIKE LOWER(${t}) || '%'`)
    );
    // Change selection table depending if we're filtering by block height or not.
    const results = await this.sql<(DbSnBalance & { total: number })[]>`
      WITH token_ids AS (
        SELECT id FROM sn_deploys AS d
        WHERE ${ticker ? ticker : this.sql`FALSE`}
      )
      ${
        args.block_height
          ? this.sql`
              SELECT
                d.ticker, d.decimals,
                SUM(b.avail_balance) AS avail_balance,
                SUM(b.trans_balance) AS trans_balance,
                SUM(b.avail_balance + b.trans_balance) AS total_balance,
                COUNT(*) OVER() as total
              FROM sn_balances AS b
              INNER JOIN sn_deploys AS d ON d.id = b.sn_deploy_id
              INNER JOIN locations AS l ON l.id = b.location_id
              WHERE
                b.address = ${args.address}
                AND l.block_height <= ${args.block_height}
                ${ticker ? this.sql`AND sn_deploy_id IN (SELECT id FROM token_ids)` : this.sql``}
              GROUP BY d.ticker, d.decimals
              HAVING SUM(b.avail_balance + b.trans_balance) > 0
            `
          : this.sql`
              SELECT d.ticker, d.decimals, b.avail_balance, b.trans_balance, b.total_balance, COUNT(*) OVER() as total
              FROM sn_total_balances AS b
              INNER JOIN sn_deploys AS d ON d.id = b.sn_deploy_id
              WHERE
                b.total_balance > 0
                AND b.address = ${args.address}
                ${ticker ? this.sql`AND sn_deploy_id IN (SELECT id FROM token_ids)` : this.sql``}
            `
      }
      LIMIT ${args.limit}
      OFFSET ${args.offset}
    `;
    return {
      total: results[0]?.total ?? 0,
      results: results ?? [],
    };
  }

  async getToken(args: { ticker: string }): Promise<DbSnTokenWithSupply | undefined> {
    const result = await this.sql<DbSnTokenWithSupply[]>`
      WITH token AS (
        SELECT
          ${this.sql(SN_DEPLOYS_COLUMNS.map(c => `d.${c}`))},
          i.number, i.genesis_id, l.timestamp
        FROM sn_deploys AS d
        INNER JOIN inscriptions AS i ON i.id = d.inscription_id
        INNER JOIN genesis_locations AS g ON g.inscription_id = d.inscription_id
        INNER JOIN locations AS l ON l.id = g.location_id
        WHERE ticker_lower = LOWER(${args.ticker})
      ),
      holders AS (
        SELECT COUNT(*) AS count
        FROM sn_total_balances
        WHERE sn_deploy_id = (SELECT id FROM token) AND total_balance > 0
      )
      SELECT *, COALESCE((SELECT count FROM holders), 0) AS holders
      FROM token
    `;
    if (result.count) return result[0];
  }

  async getTokenHolders(
    args: {
      ticker: string;
    } & DbInscriptionIndexPaging
  ): Promise<DbPaginatedResult<DbSnHolder> | undefined> {
    return await this.sqlTransaction(async sql => {
      const token = await sql<{ id: string; decimals: number }[]>`
        SELECT id, decimals FROM sn_deploys WHERE ticker_lower = LOWER(${args.ticker})
      `;
      if (token.count === 0) return;
      const results = await sql<(DbSnHolder & { total: number })[]>`
        SELECT
          address, ${token[0].decimals}::int AS decimals, total_balance, COUNT(*) OVER() AS total
        FROM sn_total_balances
        WHERE sn_deploy_id = ${token[0].id}
        ORDER BY total_balance DESC
        LIMIT ${args.limit}
        OFFSET ${args.offset}
      `;
      return {
        total: results[0]?.total ?? 0,
        results: results ?? [],
      };
    });
  }

  async getActivity(
    page: DbInscriptionIndexPaging,
    filters: {
      ticker?: string[];
      block_height?: number;
      operation?: string[];
      address?: string;
    }
  ): Promise<DbPaginatedResult<DbSnActivity>> {
    objRemoveUndefinedValues(filters);
    const filterLength = Object.keys(filters).length;
    // Do we need a specific result count such as total activity or activity per address?
    const needsGlobalEventCount = filterLength === 0 || (filterLength === 1 && filters.operation);
    const needsAddressEventCount =
      (filterLength === 1 && filters.address) ||
      (filterLength === 2 && filters.operation && filters.address);
    // Which operations do we need if we're filtering by address?
    const sanitizedOperations: DbSnEventOperation[] = [];
    for (const i of filters.operation ?? SN_OPERATIONS)
      if (SN_OPERATIONS.includes(i)) sanitizedOperations?.push(i as DbSnEventOperation);
    // Which tickers are we filtering for?
    const tickerConditions = this.sqlOr(
      filters.ticker?.map(t => this.sql`d.ticker_lower = LOWER(${t})`)
    );

    const results = await this.sql<(DbSnActivity & { total: number })[]>`
      WITH event_count AS (${
        // Select count from the correct count cache table.
        needsGlobalEventCount
          ? this.sql`
              SELECT COALESCE(SUM(count), 0) AS count
              FROM sn_counts_by_event_type
              ${
                filters.operation
                  ? this.sql`WHERE event_type IN ${this.sql(filters.operation)}`
                  : this.sql``
              }
            `
          : needsAddressEventCount
          ? this.sql`
              SELECT COALESCE(${this.sql.unsafe(sanitizedOperations.join('+'))}, 0) AS count
              FROM sn_counts_by_address_event_type
              WHERE address = ${filters.address}
            `
          : this.sql`SELECT NULL AS count`
      })
      SELECT
        e.operation,
        d.ticker,
        l.genesis_id AS inscription_id,
        l.block_height,
        l.block_hash,
        l.tx_id,
        l.address,
        l.timestamp,
        l.output,
        l.offset,
        d.max AS deploy_max,
        d.limit AS deploy_limit,
        d.decimals AS deploy_decimals,
        (SELECT amount FROM sn_mints WHERE id = e.mint_id) AS mint_amount,
        (SELECT amount || ';' || from_address || ';' || COALESCE(to_address, '') FROM sn_transfers WHERE id = e.transfer_id) AS transfer_data,
        ${
          needsGlobalEventCount || needsAddressEventCount
            ? this.sql`(SELECT count FROM event_count)`
            : this.sql`COUNT(*) OVER()`
        } AS total
      FROM sn_events AS e
      INNER JOIN sn_deploys AS d ON e.sn_deploy_id = d.id
      INNER JOIN locations AS l ON e.genesis_location_id = l.id
      WHERE TRUE
        ${
          filters.operation ? this.sql`AND operation IN ${this.sql(filters.operation)}` : this.sql``
        }
        ${tickerConditions ? this.sql`AND (${tickerConditions})` : this.sql``}
        ${
          filters.block_height ? this.sql`AND l.block_height = ${filters.block_height}` : this.sql``
        }
        ${
          filters.address
            ? this.sql`AND (e.address = ${filters.address} OR e.from_address = ${filters.address})`
            : this.sql``
        }
      ORDER BY l.block_height DESC, l.tx_index DESC
      LIMIT ${page.limit}
      OFFSET ${page.offset}
    `;
    return {
      total: results[0]?.total ?? 0,
      results: results ?? [],
    };
  }
}
