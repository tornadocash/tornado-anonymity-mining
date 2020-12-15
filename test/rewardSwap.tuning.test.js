/* global artifacts, web3, contract */
require('chai').use(require('bn-chai')(web3.utils.BN)).use(require('chai-as-promised')).should()

const { toBN, fromWei } = require('web3-utils')
const { takeSnapshot, revertSnapshot, mineBlock } = require('../scripts/ganacheHelper')
const Torn = artifacts.require('TORNMock')
const RewardSwap = artifacts.require('RewardSwapMock')
const tornConfig = require('torn-token')
const RLP = require('rlp')

// Set time to beginning of a second
async function timeReset() {
  const delay = 1000 - new Date().getMilliseconds()
  await new Promise((resolve) => setTimeout(resolve, delay))
  await mineBlock()
}

async function getNextAddr(sender, offset = 0) {
  const nonce = await web3.eth.getTransactionCount(sender)
  return (
    '0x' +
    web3.utils
      .sha3(RLP.encode([sender, Number(nonce) + Number(offset)]))
      .slice(12)
      .substring(14)
  )
}

// todo mock's fixed timestamp interferes with simulation
contract.skip('RewardSwap simulation', (accounts) => {
  let torn
  let rewardSwap
  const sender = accounts[0]
  const recipient = accounts[1]
  const tornCap = toBN(tornConfig.torn.cap)
  const miningCap = toBN(tornConfig.torn.distribution.miningV2.amount)
  const initialTornBalance = toBN(tornConfig.miningV2.initialBalance)
  const poolWeight = 1e11
  let snapshotId

  async function increaseTimeDays(days, verbose = true) {
    if (verbose) {
      console.log(`Skipping ${days} days`)
    }

    const timestamp = await rewardSwap.getTimestamp()
    await rewardSwap.setTimestamp(Number(timestamp) + 60 * 60 * 24 * Number(days))
  }

  async function exchange(points, verbose = true) {
    const balanceBefore = await torn.balanceOf(recipient)
    await rewardSwap.swap(recipient, points, { from: sender })
    const balanceAfter = await torn.balanceOf(recipient)
    const poolSize = await rewardSwap.tornVirtualBalance()
    if (verbose) {
      console.log(
        `Exchanged ${points} points for ${fromWei(
          balanceAfter.sub(balanceBefore),
        )} TORN. Remaining in pool ${fromWei(poolSize)} TORN`,
      )
    }
  }

  before(async () => {
    const swapExpectedAddr = await getNextAddr(accounts[0], 1)
    torn = await Torn.new(sender, 0, [
      { to: swapExpectedAddr, amount: miningCap.toString() },
      { to: sender, amount: tornCap.sub(miningCap).toString() },
    ])
    rewardSwap = await RewardSwap.new(
      torn.address,
      sender,
      miningCap.toString(),
      initialTornBalance.toString(),
      poolWeight,
    )

    snapshotId = await takeSnapshot()
  })

  beforeEach(async () => {
    await timeReset()
  })

  describe('Swap Simulations', () => {
    it('init', async () => {
      console.log('Cap', fromWei(miningCap))
      console.log('Virtual balance', fromWei(await rewardSwap.tornVirtualBalance()))
    })

    it('rates', async () => {
      let k = toBN(1)
      for (let i = 0; i < 18; i++) {
        console.log(
          `Expected return for 10^${i} points: ${fromWei(await rewardSwap.getExpectedReturn(k))} TORN`,
        )
        k = k.mul(toBN(10))
      }
    })

    it.skip('sim1', async () => {
      await exchange(1e8)
      await exchange(1e8)
      await increaseTimeDays(1)
      await exchange(1e8)
    })

    it('equilibrium sim', async () => {
      const amountPerDay = 7.2e9
      for (let i = 0; i <= 450; i++) {
        const verbose = i < 15 || i % 30 === 0 || (i > 360 && i < 370)
        if (verbose) {
          console.log(`Day ${i}`)
        }
        await exchange(amountPerDay, verbose)
        await increaseTimeDays(1, false)
      }
    })
  })

  afterEach(async () => {
    await revertSnapshot(snapshotId.result)
    // eslint-disable-next-line require-atomic-updates
    snapshotId = await takeSnapshot()
  })
})
