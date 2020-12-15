# Tornado.cash anonymity mining [![Build Status](https://github.com/tornadocash/tornado-anonymity-mining/workflows/build/badge.svg)](https://github.com/tornadocash/tornado-anonymity-mining/actions)

## Dependencies

1. node 12
2. yarn
3. zkutil (`brew install rust && cargo install zkutil`)

## Start

```bash
$ yarn
$ cp .env.example .env
$ yarn circuit
$ yarn test
```

## Deploying

Deploy to Kovan:

```bash
$ yarn deploy:kovan
```
