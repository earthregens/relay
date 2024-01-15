Social Network API

A service that indexers Bitcoin ordinal inscriptions for the Social Network and exposes them via valid (NIP-77) websocket subscriptions.

* [Features](#features)
* [API Reference](#api-reference)
* [Quick Start](#quick-start)
    * [System Requirements](#system-requirements)
    * [Running the API](#running-the-api)
    * [Run Modes](#run-modes)
    * [Stopping the API](#stopping-the-api)
* [Bugs and Feature Requests](#bugs-and-feature-requests)
* [Contribute](#contribute)
* [Community](#community)

***

# Features

* Bitcoin Inscriptions
    * Genesis block and transaction information
    * Transfer history
    * Transfers per block
    * Current location and ownership information
    * Blessed and cursed inscriptions
* Social Network
    * Bitcoin Stake, and Unstake Transactions (TODO)
    * Activities per token and per address
    * Address HEART balances
* Satoshi ordinal notation endpoints
* ETag cache support
* Run modes for auto-scaling

# API Reference

See the [API Reference](https://docs.earthstaking.com/api/) for more
information.

# Quick Start

## System Requirements

The Social Network API has hard dependencies on other systems. Before you start, you'll need to have access to:

1. An [Indexer node](https://github.com/earthstaking/indexer) with a fully
   indexed Ordinals database.
1. A local writeable Postgres database for data storage

## Running the API

1. Clone the repo.

1. Create an `.env` file and specify the appropriate values to configure the local
API server, postgres DB and indexer node reachability. See
[`env.ts`](https://github.com/social-network/api/blob/develop/src/env.ts)
for all available configuration options.

1. Build the app (NodeJS v18+ is required)
    ```
    npm install
    npm run build
    ```

1. Start the service
    ```
    npm run start
    ```

### Run Modes

To better support auto-scaling server configurations, this service supports
three run modes specified by the `RUN_MODE` environment variable:

* `default`: Runs all background jobs and the API server. Use this when you're
  running this service only on one instance. This is the default mode.
* `readonly`: Runs only the API server. Use this in an auto-scaled cluster when
  you have multiple `readonly` instances and just one `writeonly` instance. This
  mode needs a `writeonly` instance to continue populating the DB.
* `writeonly`: Use one of these in an auto-scaled environment so you can
  continue consuming new inscriptions. Use in conjunction with multiple
  `readonly` instances as explained above.

### Stopping the API

When shutting down, you should always prefer to send the `SIGINT` signal instead
of `SIGKILL` so the service has time to finish any pending background work and
all dependencies are gracefully disconnected.

# Bugs and feature requests

If you encounter a bug or have a feature request, we encourage you to [open a new issue](../../issues/new/choose). Choose the appropriate issue template and provide as much detail as possible, including steps to reproduce the bug or a clear description of the requested feature.

# Contribute

Development of this product happens in the open on GitHub, and we are grateful
to the community for contributing bugfixes and improvements. Read below to learn
how you can take part in improving the product.

## Code of Conduct
Please read our [Code of conduct](../../../.github/blob/main/CODE_OF_CONDUCT.md)
since we expect project participants to adhere to it. 

## Contributing Guide
Read our [contributing guide](.github/CONTRIBUTING.md) to learn about our
development process, how to propose bugfixes and improvements, and how to build
and test your changes.
