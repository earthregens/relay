import { Static, Type } from '@fastify/type-provider-typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import BigNumber from 'bignumber.js';
import { hexToBuffer } from '../../../api/util/helpers';
import { DbInscriptionInsert } from '../../../pg/types';

const snTickerSchema = Type.String({ minLength: 1 });
const snNumberSchema = Type.RegEx(/^((\d+)|(\d*\.?\d+))$/);

const snDeploySchema = Type.Object(
  {
    p: Type.Literal('sn'),
    op: Type.Literal('stake'),
    tick: snTickerSchema,
    max: snNumberSchema,
    lim: Type.Optional(snNumberSchema),
    dec: Type.Optional(Type.RegEx(/^\d+$/)),
  },
  { additionalProperties: true }
);
export type snDeploy = Static<typeof snDeploySchema>;

const snMintSchema = Type.Object(
  {
    p: Type.Literal('sn'),
    op: Type.Literal('unstake'),
    tick: snTickerSchema,
    amt: snNumberSchema,
  },
  { additionalProperties: true }
);
export type snMint = Static<typeof snMintSchema>;

const snTransferSchema = Type.Object(
  {
    p: Type.Literal('sn'),
    op: Type.Literal('transfer'),
    tick: snTickerSchema,
    amt: snNumberSchema,
  },
  { additionalProperties: true }
);
export type snTransfer = Static<typeof snTransferSchema>;

const snSchema = Type.Union([snDeploySchema, snMintSchema, snTransferSchema]);
const snC = TypeCompiler.Compile(snSchema);
export type sn = Static<typeof snSchema>;

const UINT64_MAX = BigNumber('18446744073709551615'); // 20 digits
// Only compare against `UINT64_MAX` if the number is at least the same number of digits.
const numExceedsMax = (num: string) => num.length >= 20 && UINT64_MAX.isLessThan(num);

// For testing only
export function snFromInscription(inscription: DbInscriptionInsert): sn | undefined {
  if (inscription.number < 0) return;
  if (inscription.mime_type !== 'text/plain' && inscription.mime_type !== 'application/json')
    return;
  const buf = hexToBuffer(inscription.content as string).toString('utf-8');
  return snFromInscriptionContent(buf);
}

export function snFromInscriptionContent(content: string): sn | undefined {
  try {
    const json = JSON.parse(content);
    if (snC.Check(json)) {
      // Check ticker byte length
      if (Buffer.from(json.tick).length !== 4) return;
      // Check numeric values.
      if (json.op === 'deploy') {
        if (parseFloat(json.max) == 0 || numExceedsMax(json.max)) return;
        if (json.lim && (parseFloat(json.lim) == 0 || numExceedsMax(json.lim))) return;
        if (json.dec && parseFloat(json.dec) > 18) return;
      } else {
        if (parseFloat(json.amt) == 0 || numExceedsMax(json.amt)) return;
      }
      return json;
    }
  } catch (error) {
    // Not a sn inscription.
  }
}

export function isAddressSentAsFee(address: string | null): boolean {
  return address === null || address.length === 0;
}
