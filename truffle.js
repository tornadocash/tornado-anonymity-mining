require('dotenv').config()
const HDWalletProvider = require('truffle-hdwallet-provider')
const utils = require('web3-utils')
const { PRIVATE_KEY, INFURA_TOKEN } = process.env

module.exports = {
  // Uncommenting the defaults below
  // provides for an easier quick-start with Ganache.
  // You can also follow this format for other networks;
  // see <http://truffleframework.com/docs/advanced/configuration>
  // for more details on how to specify configuration options!
  //
  networks: {
    // development: {
    //   host: '127.0.0.1',
    //   port: 8545,
    //   network_id: '*',
    // },
    //  test: {
    //    host: "127.0.0.1",
    //    port: 7545,
    //    network_id: "*"
    //  }
    mainnet: {
      provider: () => new HDWalletProvider(PRIVATE_KEY, `https://mainnet.infura.io/v3/${INFURA_TOKEN}`),
      network_id: 1,
      gas: 6000000,
      gasPrice: utils.toWei('100', 'gwei'),
      // confirmations: 0,
      // timeoutBlocks: 200,
      skipDryRun: true,
    },
    kovan: {
      provider: () => new HDWalletProvider(PRIVATE_KEY, `https://kovan.infura.io/v3/${INFURA_TOKEN}`),
      network_id: 42,
      gas: 6000000,
      gasPrice: utils.toWei('1', 'gwei'),
      // confirmations: 0,
      // timeoutBlocks: 200,
      skipDryRun: true,
    },
    coverage: {
      host: 'localhost',
      network_id: '*',
      port: 8554, // <-- If you change this, also set the port option in .solcover.js.
      gas: 0xfffffffffff, // <-- Use this high gas value
      gasPrice: 0x01, // <-- Use this low gas price
    },
  },
  compilers: {
    solc: {
      version: '0.6.12',
      settings: {
        optimizer: {
          enabled: true,
          runs: 200,
        },
      },
    },
    external: {
      command: 'node ./compileHasher.js',
      targets: [
        {
          path: './build/contracts/Hasher2.json',
        },
        {
          path: './build/contracts/Hasher3.json',
        },
      ],
    },
  },
  plugins: ['truffle-plugin-verify', 'solidity-coverage'],
}
