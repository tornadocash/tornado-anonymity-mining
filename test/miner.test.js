/* global artifacts, web3, contract */
require('chai').use(require('bn-chai')(web3.utils.BN)).use(require('chai-as-promised')).should()

const fs = require('fs')
const { toBN } = require('web3-utils')
const { takeSnapshot, revertSnapshot, mineBlock } = require('../scripts/ganacheHelper')
const tornConfig = require('torn-token')
const RLP = require('rlp')
const Controller = require('../src/controller')
const Account = require('../src/account')
const Note = require('../src/note')
const {
  toFixedHex,
  poseidonHash2,
  packEncryptedMessage,
  unpackEncryptedMessage,
  getExtWithdrawArgsHash,
} = require('../src/utils')
const { getEncryptionPublicKey } = require('eth-sig-util')
const Miner = artifacts.require('MinerMock')
const TornadoTrees = artifacts.require('TornadoTreesMock')
const Torn = artifacts.require('TORNMock')
const RewardSwap = artifacts.require('RewardSwapMock')
const RewardVerifier = artifacts.require('RewardVerifier')
const WithdrawVerifier = artifacts.require('WithdrawVerifier')
const TreeUpdateVerifier = artifacts.require('TreeUpdateVerifier')
const provingKeys = {
  rewardCircuit: require('../build/circuits/Reward.json'),
  withdrawCircuit: require('../build/circuits/Withdraw.json'),
  treeUpdateCircuit: require('../build/circuits/TreeUpdate.json'),
  rewardProvingKey: fs.readFileSync('./build/circuits/Reward_proving_key.bin').buffer,
  withdrawProvingKey: fs.readFileSync('./build/circuits/Withdraw_proving_key.bin').buffer,
  treeUpdateProvingKey: fs.readFileSync('./build/circuits/TreeUpdate_proving_key.bin').buffer,
}
const MerkleTree = require('fixed-merkle-tree')
const Hasher2 = artifacts.require('Hasher2')
const Hasher3 = artifacts.require('Hasher3')

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

async function registerNote(note, tornadoTrees) {
  await tornadoTrees.setBlockNumber(note.depositBlock)
  await tornadoTrees.registerDeposit(note.instance, toFixedHex(note.commitment))

  await tornadoTrees.setBlockNumber(note.withdrawalBlock)
  await tornadoTrees.registerWithdrawal(note.instance, toFixedHex(note.nullifierHash))

  return {
    depositLeaf: {
      instance: note.instance,
      hash: toFixedHex(note.commitment),
      block: toFixedHex(note.depositBlock),
    },
    withdrawalLeaf: {
      instance: note.instance,
      hash: toFixedHex(note.nullifierHash),
      block: toFixedHex(note.withdrawalBlock),
    },
  }
}

contract('Miner', (accounts) => {
  let miner
  let torn
  let rewardSwap
  let tornadoTrees
  const tornado = '0x3535249DFBb73e21c2aCDC6e42796d920A0379b7'
  const tornCap = toBN(tornConfig.torn.cap)
  const miningCap = toBN(tornConfig.torn.distribution.miningV2.amount)
  const initialTornBalance = toBN(tornConfig.miningV2.initialBalance)
  const RATE = toBN(10)
  const amount = toBN(15)
  // eslint-disable-next-line no-unused-vars
  const sender = accounts[0]
  const recipient = accounts[1]
  // eslint-disable-next-line no-unused-vars
  const relayer = accounts[2]
  const levels = MERKLE_TREE_HEIGHT || 20
  let snapshotId
  const AnotherWeb3 = require('web3')
  let contract
  let controller
  const note1 = new Note({
    instance: tornado,
    depositBlock: 10,
    withdrawalBlock: 10 + 4 * 60 * 24,
  })
  const note2 = new Note({
    instance: tornado,
    depositBlock: 10,
    withdrawalBlock: 10 + 2 * 4 * 60 * 24,
  })
  const note3 = new Note({
    instance: tornado,
    depositBlock: 10,
    withdrawalBlock: 10 + 3 * 4 * 60 * 24,
  })
  const note = note1
  const notes = [note1, note2, note3]

  const emptyTree = new MerkleTree(levels, [], { hashFunction: poseidonHash2 })
  const privateKey = web3.eth.accounts.create().privateKey.slice(2)
  const publicKey = getEncryptionPublicKey(privateKey)
  const operator = accounts[0]
  const thirtyDays = 30 * 24 * 3600
  const poolWeight = 1e11
  const governance = accounts[9]

  before(async () => {
    const rewardVerifier = await RewardVerifier.new()
    const withdrawVerifier = await WithdrawVerifier.new()
    const treeUpdateVerifier = await TreeUpdateVerifier.new()
    const hasher2 = await Hasher2.new()
    const hasher3 = await Hasher3.new()
    tornadoTrees = await TornadoTrees.new(operator, hasher2.address, hasher3.address, levels)
    const swapExpectedAddr = await getNextAddr(accounts[0], 1)
    const minerExpectedAddr = await getNextAddr(accounts[0], 2)
    torn = await Torn.new(sender, thirtyDays, [
      { to: swapExpectedAddr, amount: miningCap.toString() },
      { to: sender, amount: tornCap.sub(miningCap).toString() },
    ])
    rewardSwap = await RewardSwap.new(
      torn.address,
      minerExpectedAddr,
      miningCap.toString(),
      initialTornBalance.toString(),
      poolWeight,
    )
    miner = await Miner.new(
      rewardSwap.address,
      governance,
      tornadoTrees.address,
      [rewardVerifier.address, withdrawVerifier.address, treeUpdateVerifier.address],
      toFixedHex(emptyTree.root()),
      [{ instance: tornado, value: RATE.toString() }],
    )

    const depositData = []
    const withdrawalData = []
    for (const note of notes) {
      const { depositLeaf, withdrawalLeaf } = await registerNote(note, tornadoTrees)
      depositData.push(depositLeaf)
      withdrawalData.push(withdrawalLeaf)
    }

    await tornadoTrees.updateRoots(depositData, withdrawalData)

    const anotherWeb3 = new AnotherWeb3(web3.currentProvider)
    contract = new anotherWeb3.eth.Contract(miner.abi, miner.address)
    const tornadoTreesContract = new anotherWeb3.eth.Contract(tornadoTrees.abi, tornadoTrees.address)
    controller = new Controller({
      contract,
      tornadoTreesContract,
      merkleTreeHeight: levels,
      provingKeys,
    })
    await controller.init()
    snapshotId = await takeSnapshot()
  })

  beforeEach(async () => {
    await timeReset()
  })

  describe('#constructor', () => {
    it('should initialize', async () => {
      const tokenFromContract = await rewardSwap.torn()
      tokenFromContract.should.be.equal(torn.address)

      const rewardSwapFromContract = await miner.rewardSwap()
      rewardSwapFromContract.should.be.equal(rewardSwap.address)

      const rateFromContract = await miner.rates(tornado)
      rateFromContract.should.be.eq.BN(RATE)
    })
  })

  describe('#Note.fromString()', () => {
    it('should work', () => {
      const note = Note.fromString(
        'tornado-eth-1-1-0x3a1f1e0e10b22b15ed8208bc810dd5564d564fd7930874db4d7d58870deb72978fb5fccae2f1554cac71e2cff85f9c8908295647adf2b443a4dd93635d8d',
        '0x8b3f5393bA08c24cc7ff5A66a832562aAB7bC95f',
        10,
        15,
      )
      note.secret.should.be.eq.BN(toBN('0x8d5d6393dda443b4f2ad47562908899c5ff8cfe271ac4c55f1e2cafcb58f97'))
      note.nullifier.should.be.eq.BN(toBN('0x72eb0d87587d4ddb740893d74f564d56d50d81bc0882ed152bb2100e1e1f3a'))
      note.nullifierHash.should.be.eq.BN(
        toBN('0x33403728f37e70a275acac2eb8297a3231698f9003838ec4cd7115ee2693943'),
      )
      note.commitment.should.be.eq.BN(
        toBN('0x1a08fd10dae9806ce25b62582e44d237c1cb9f8d6bf73e756f18d0e5d7a7351a'),
      )
    })
  })

  describe('#Account', () => {
    it('should throw on negative amount', () => {
      ;(() => new Account({ amount: toBN(-1) })).should.throw('Cannot create an account with negative amount')
    })
  })

  describe('#encrypt', () => {
    it('should work', () => {
      const account = new Account()
      const encryptedAccount = account.encrypt(publicKey)
      const encryptedMessage = packEncryptedMessage(encryptedAccount)
      const unpackedMessage = unpackEncryptedMessage(encryptedMessage)
      const account2 = Account.decrypt(privateKey, unpackedMessage)

      account.amount.should.be.eq.BN(account2.amount)
      account.secret.should.be.eq.BN(account2.secret)
      account.nullifier.should.be.eq.BN(account2.nullifier)
      account.commitment.should.be.eq.BN(account2.commitment)
    })
  })

  describe('#reward', () => {
    it('should work', async () => {
      const zeroAccount = new Account()
      const accountCount = await miner.accountCount()

      zeroAccount.amount.should.be.eq.BN(toBN(0))

      const rewardNullifierBefore = await miner.rewardNullifiers(toFixedHex(note.rewardNullifier))
      rewardNullifierBefore.should.be.false
      const accountNullifierBefore = await miner.accountNullifiers(toFixedHex(zeroAccount.nullifier))
      accountNullifierBefore.should.be.false

      const { proof, args, account } = await controller.reward({ account: zeroAccount, note, publicKey })
      const { logs } = await miner.reward(proof, args)
      logs[0].event.should.be.equal('NewAccount')
      logs[0].args.commitment.should.be.equal(toFixedHex(account.commitment))
      logs[0].args.index.should.be.eq.BN(accountCount)

      logs[0].args.nullifier.should.be.equal(toFixedHex(zeroAccount.nullifierHash))

      const encryptedAccount = logs[0].args.encryptedAccount
      const account2 = Account.decrypt(privateKey, unpackEncryptedMessage(encryptedAccount))
      account.amount.should.be.eq.BN(account2.amount)
      account.secret.should.be.eq.BN(account2.secret)
      account.nullifier.should.be.eq.BN(account2.nullifier)
      account.commitment.should.be.eq.BN(account2.commitment)

      const accountCountAfter = await miner.accountCount()
      accountCountAfter.should.be.eq.BN(accountCount.add(toBN(1)))
      const rootAfter = await miner.getLastAccountRoot()
      rootAfter.should.be.equal(args.account.outputRoot)
      const rewardNullifierAfter = await miner.rewardNullifiers(toFixedHex(note.rewardNullifier))
      rewardNullifierAfter.should.be.true
      const accountNullifierAfter = await miner.accountNullifiers(toFixedHex(zeroAccount.nullifierHash))
      accountNullifierAfter.should.be.true

      account.amount.should.be.eq.BN(toBN(note.withdrawalBlock - note.depositBlock).mul(RATE))
    })

    it('should send fee to relayer', async () => {
      const fee = toBN(3)
      const amount = toBN(44)
      const delta = toBN('10000') // max floating point error

      const claim = await controller.reward({ account: new Account(), note, publicKey, relayer, fee })
      await timeReset()
      let expectedFeeInTorn = await rewardSwap.getExpectedReturn(fee)
      let relayerBalanceBefore = await torn.balanceOf(relayer)
      await miner.reward(claim.proof, claim.args)
      let relayerBalanceAfter = await torn.balanceOf(relayer)
      relayerBalanceAfter.should.be.eq.BN(relayerBalanceBefore.add(expectedFeeInTorn))

      const withdrawal = await controller.withdraw({
        account: claim.account,
        amount,
        recipient,
        publicKey,
        relayer,
        fee,
      })
      await timeReset()
      const expectedAmountInTorn = await rewardSwap.getExpectedReturn(amount)
      expectedFeeInTorn = await rewardSwap.getExpectedReturn(amount.add(fee))
      expectedFeeInTorn = expectedFeeInTorn.sub(expectedAmountInTorn)

      relayerBalanceBefore = await torn.balanceOf(relayer)
      const recipientBalanceBefore = await torn.balanceOf(recipient)
      await miner.withdraw(withdrawal.proof, withdrawal.args)
      const recipientBalanceAfter = await torn.balanceOf(recipient)
      relayerBalanceAfter = await torn.balanceOf(relayer)

      recipientBalanceAfter.should.be.eq.BN(recipientBalanceBefore.add(expectedAmountInTorn))
      relayerBalanceAfter.sub(relayerBalanceBefore).sub(expectedFeeInTorn).should.be.lt.BN(delta)
    })

    it('should use fallback with outdated tree', async () => {
      const { proof, args, account } = await controller.reward({ account: new Account(), note, publicKey })

      const tmp = await controller.reward({ account: new Account(), note: note2, publicKey })
      await miner.reward(tmp.proof, tmp.args)

      await miner.reward(proof, args).should.be.rejectedWith('Outdated account merkle root')

      const update = await controller.treeUpdate(account.commitment)
      await miner.reward(proof, args, update.proof, update.args)

      const rootAfter = await miner.getLastAccountRoot()
      rootAfter.should.be.equal(update.args.newRoot)
    })

    it('should reject with incorrect insert position', async () => {
      const tmp = await controller.reward({ account: new Account(), note: note2, publicKey })
      await miner.reward(tmp.proof, tmp.args)

      const { proof, args } = await controller.reward({ account: new Account(), note, publicKey })
      const malformedArgs = JSON.parse(JSON.stringify(args))

      let fakeIndex = toBN(args.account.outputPathIndices).sub(toBN('1'))
      malformedArgs.account.outputPathIndices = toFixedHex(fakeIndex)
      await miner.reward(proof, malformedArgs).should.be.rejectedWith('Incorrect account insert index')

      fakeIndex = toBN(args.account.outputPathIndices).add(toBN('1'))
      malformedArgs.account.outputPathIndices = toFixedHex(fakeIndex)
      await miner.reward(proof, malformedArgs).should.be.rejectedWith('Incorrect account insert index')

      fakeIndex = toBN(args.account.outputPathIndices).add(toBN('10000000000000000000000000'))
      malformedArgs.account.outputPathIndices = toFixedHex(fakeIndex)
      await miner.reward(proof, malformedArgs).should.be.rejectedWith('Incorrect account insert index')

      await miner.reward(proof, args).should.be.fulfilled
    })

    it('should reject with incorrect external data hash', async () => {
      const { proof, args } = await controller.reward({ account: new Account(), note, publicKey })
      const malformedArgs = JSON.parse(JSON.stringify(args))

      malformedArgs.extDataHash = toFixedHex('0xdeadbeef')
      await miner.reward(proof, malformedArgs).should.be.rejectedWith('Incorrect external data hash')

      malformedArgs.extDataHash = toFixedHex('0x00')
      await miner.reward(proof, malformedArgs).should.be.rejectedWith('Incorrect external data hash')

      await miner.reward(proof, args).should.be.fulfilled
    })

    it('should prevent fee overflow', async () => {
      const { proof, args } = await controller.reward({ account: new Account(), note, publicKey })
      const malformedArgs = JSON.parse(JSON.stringify(args))

      malformedArgs.fee = toFixedHex(toBN(2).pow(toBN(248)))
      await miner.reward(proof, malformedArgs).should.be.rejectedWith('Fee value out of range')

      malformedArgs.fee = toFixedHex(toBN(2).pow(toBN(256)).sub(toBN(1)))
      await miner.reward(proof, malformedArgs).should.be.rejectedWith('Fee value out of range')

      await miner.reward(proof, args).should.be.fulfilled
    })

    it('should reject with invalid reward rate', async () => {
      const { proof, args } = await controller.reward({ account: new Account(), note, publicKey })
      const malformedArgs = JSON.parse(JSON.stringify(args))

      malformedArgs.instance = miner.address
      await miner.reward(proof, malformedArgs).should.be.rejectedWith('Invalid reward rate')

      malformedArgs.rate = toFixedHex(toBN(9999999))
      await miner.reward(proof, malformedArgs).should.be.rejectedWith('Invalid reward rate')

      malformedArgs.instance = toFixedHex('0x00', 20)
      await miner.reward(proof, malformedArgs).should.be.rejectedWith('Invalid reward rate')

      const anotherInstance = accounts[5]
      const rate = toBN(1000)
      await miner.setRates([{ instance: anotherInstance, value: rate.toString() }], { from: governance })

      malformedArgs.instance = anotherInstance
      malformedArgs.rate = toFixedHex(rate)
      await miner.reward(proof, malformedArgs).should.be.rejectedWith('Invalid reward proof')

      await miner.reward(proof, args).should.be.fulfilled
    })

    it('should reject for double spend', async () => {
      let { proof, args } = await controller.reward({ account: new Account(), note, publicKey })
      await miner.reward(proof, args).should.be.fulfilled
      ;({ proof, args } = await controller.reward({ account: new Account(), note, publicKey }))
      await miner.reward(proof, args).should.be.rejectedWith('Reward has been already spent')
    })

    it('should reject for invalid proof', async () => {
      const claim1 = await controller.reward({ account: new Account(), note, publicKey })
      const claim2 = await controller.reward({ account: new Account(), note: note2, publicKey })

      await miner.reward(claim2.proof, claim1.args).should.be.rejectedWith('Invalid reward proof')
    })

    it('should reject for invalid account root', async () => {
      const account1 = new Account()
      const account2 = new Account()
      const account3 = new Account()

      const fakeTree = new MerkleTree(
        levels,
        [account1.commitment, account2.commitment, account3.commitment],
        { hashFunction: poseidonHash2 },
      )
      const { proof, args } = await controller.reward({ account: account1, note, publicKey })
      const malformedArgs = JSON.parse(JSON.stringify(args))
      malformedArgs.account.inputRoot = toFixedHex(fakeTree.root())
      await miner.reward(proof, malformedArgs).should.be.rejectedWith('Invalid account root')
    })

    it('should reject with outdated account root (treeUpdate proof validation)', async () => {
      const { proof, args, account } = await controller.reward({ account: new Account(), note, publicKey })

      const tmp = await controller.reward({ account: new Account(), note: note2, publicKey })
      await miner.reward(tmp.proof, tmp.args)

      await miner.reward(proof, args).should.be.rejectedWith('Outdated account merkle root')

      const update = await controller.treeUpdate(account.commitment)

      const tmp2 = await controller.reward({ account: new Account(), note: note3, publicKey })
      await miner.reward(tmp2.proof, tmp2.args)

      await miner
        .reward(proof, args, update.proof, update.args)
        .should.be.rejectedWith('Outdated tree update merkle root')
    })

    it('should reject for incorrect commitment (treeUpdate proof validation)', async () => {
      const claim = await controller.reward({ account: new Account(), note, publicKey })

      const tmp = await controller.reward({ account: new Account(), note: note2, publicKey })
      await miner.reward(tmp.proof, tmp.args)

      await miner.reward(claim.proof, claim.args).should.be.rejectedWith('Outdated account merkle root')
      const anotherAccount = new Account()
      const update = await controller.treeUpdate(anotherAccount.commitment)

      await miner
        .reward(claim.proof, claim.args, update.proof, update.args)
        .should.be.rejectedWith('Incorrect commitment inserted')

      claim.args.account.outputCommitment = update.args.leaf
      await miner
        .reward(claim.proof, claim.args, update.proof, update.args)
        .should.be.rejectedWith('Invalid reward proof')
    })

    it('should reject for incorrect account insert index (treeUpdate proof validation)', async () => {
      const { proof, args, account } = await controller.reward({ account: new Account(), note, publicKey })

      const tmp = await controller.reward({ account: new Account(), note: note2, publicKey })
      await miner.reward(tmp.proof, tmp.args)

      await miner.reward(proof, args).should.be.rejectedWith('Outdated account merkle root')

      const update = await controller.treeUpdate(account.commitment)
      const malformedArgs = JSON.parse(JSON.stringify(update.args))

      let fakeIndex = toBN(update.args.pathIndices).sub(toBN('1'))
      malformedArgs.pathIndices = toFixedHex(fakeIndex)

      await miner
        .reward(proof, args, update.proof, malformedArgs)
        .should.be.rejectedWith('Incorrect account insert index')
    })

    it('should reject for invalid tree update proof (treeUpdate proof validation)', async () => {
      const { proof, args, account } = await controller.reward({ account: new Account(), note, publicKey })

      const tmp = await controller.reward({ account: new Account(), note: note2, publicKey })
      await miner.reward(tmp.proof, tmp.args)

      await miner.reward(proof, args).should.be.rejectedWith('Outdated account merkle root')

      const update = await controller.treeUpdate(account.commitment)
      await miner
        .reward(proof, args, tmp.proof, update.args)
        .should.be.rejectedWith('Invalid tree update proof')
    })

    it('should work with outdated deposit or withdrawal merkle root', async () => {
      const note0 = new Note({
        instance: tornado,
        depositBlock: 10,
        withdrawalBlock: 55,
      })
      const note4 = new Note({
        instance: tornado,
        depositBlock: 10,
        withdrawalBlock: 55,
      })
      const note5 = new Note({
        instance: tornado,
        depositBlock: 10,
        withdrawalBlock: 65,
      })

      const claim1 = await controller.reward({ account: new Account(), note: note3, publicKey })

      const note4Leaves = await registerNote(note4, tornadoTrees)
      await tornadoTrees.updateRoots([note4Leaves.depositLeaf], [note4Leaves.withdrawalLeaf])

      const claim2 = await controller.reward({ account: new Account(), note: note4, publicKey })

      for (let i = 0; i < 9; i++) {
        const note0Leaves = await registerNote(note0, tornadoTrees)
        await tornadoTrees.updateRoots([note0Leaves.depositLeaf], [note0Leaves.withdrawalLeaf])
      }

      await miner.reward(claim1.proof, claim1.args).should.be.rejectedWith('Incorrect deposit tree root')
      await miner.reward(claim2.proof, claim2.args).should.be.fulfilled

      const note5Leaves = await registerNote(note5, tornadoTrees)
      await tornadoTrees.updateRoots([note5Leaves.depositLeaf], [note5Leaves.withdrawalLeaf])

      const claim3 = await controller.reward({ account: new Account(), note: note5, publicKey })
      await miner.reward(claim3.proof, claim3.args).should.be.fulfilled
    })
  })

  describe('#withdraw', () => {
    let proof, args, account
    // prettier-ignore
    beforeEach(async () => {
      ({ proof, args, account } = await controller.reward({ account: new Account(), note, publicKey }))
      await miner.reward(proof, args)
    })

    it('should work', async () => {
      const accountNullifierBefore = await miner.accountNullifiers(toFixedHex(account.nullifierHash))
      accountNullifierBefore.should.be.false

      const accountCount = await miner.accountCount()
      const withdrawSnark = await controller.withdraw({ account, amount, recipient, publicKey })
      await timeReset()
      const expectedAmountInTorn = await rewardSwap.getExpectedReturn(amount)
      const balanceBefore = await torn.balanceOf(recipient)
      const { logs } = await miner.withdraw(withdrawSnark.proof, withdrawSnark.args)
      const balanceAfter = await torn.balanceOf(recipient)
      balanceAfter.should.be.eq.BN(balanceBefore.add(expectedAmountInTorn))

      const accountCountAfter = await miner.accountCount()
      accountCountAfter.should.be.eq.BN(accountCount.add(toBN(1)))
      const rootAfter = await miner.getLastAccountRoot()
      rootAfter.should.be.equal(withdrawSnark.args.account.outputRoot)
      const accountNullifierAfter = await miner.accountNullifiers(toFixedHex(account.nullifierHash))
      accountNullifierAfter.should.be.true

      logs[0].event.should.be.equal('NewAccount')
      logs[0].args.commitment.should.be.equal(toFixedHex(withdrawSnark.account.commitment))
      logs[0].args.index.should.be.eq.BN(accountCount)
      logs[0].args.nullifier.should.be.equal(toFixedHex(account.nullifierHash))

      const encryptedAccount = logs[0].args.encryptedAccount
      const account2 = Account.decrypt(privateKey, unpackEncryptedMessage(encryptedAccount))
      withdrawSnark.account.amount.should.be.eq.BN(account2.amount)
      withdrawSnark.account.secret.should.be.eq.BN(account2.secret)
      withdrawSnark.account.nullifier.should.be.eq.BN(account2.nullifier)
      withdrawSnark.account.commitment.should.be.eq.BN(account2.commitment)
    })

    it('should reject for double spend', async () => {
      const withdrawSnark = await controller.withdraw({ account, amount, recipient, publicKey })
      await timeReset()
      const balanceBefore = await torn.balanceOf(recipient)
      const expectedAmountInTorn = await rewardSwap.getExpectedReturn(amount)
      await miner.withdraw(withdrawSnark.proof, withdrawSnark.args)
      const balanceAfter = await torn.balanceOf(recipient)
      balanceAfter.should.be.eq.BN(balanceBefore.add(expectedAmountInTorn))

      await miner
        .withdraw(withdrawSnark.proof, withdrawSnark.args)
        .should.be.rejectedWith('Outdated account state')
    })

    it('should reject with incorrect insert position', async () => {
      const { proof, args } = await controller.withdraw({ account, amount, recipient, publicKey })
      const malformedArgs = JSON.parse(JSON.stringify(args))

      let fakeIndex = toBN(args.account.outputPathIndices).sub(toBN('1'))
      malformedArgs.account.outputPathIndices = toFixedHex(fakeIndex)
      await miner.withdraw(proof, malformedArgs).should.be.rejectedWith('Incorrect account insert index')

      fakeIndex = toBN(args.account.outputPathIndices).add(toBN('1'))
      malformedArgs.account.outputPathIndices = toFixedHex(fakeIndex)
      await miner.withdraw(proof, malformedArgs).should.be.rejectedWith('Incorrect account insert index')

      fakeIndex = toBN(args.account.outputPathIndices).add(toBN('10000000000000000000000000'))
      malformedArgs.account.outputPathIndices = toFixedHex(fakeIndex)
      await miner.withdraw(proof, malformedArgs).should.be.rejectedWith('Incorrect account insert index')

      const balanceBefore = await torn.balanceOf(recipient)
      const expectedAmountInTorn = await rewardSwap.getExpectedReturn(amount)
      await miner.withdraw(proof, args)
      const balanceAfter = await torn.balanceOf(recipient)
      balanceAfter.should.be.eq.BN(balanceBefore.add(expectedAmountInTorn))
    })

    it('should reject with incorrect external data hash', async () => {
      const { proof, args } = await controller.withdraw({ account, amount, recipient, publicKey })
      const malformedArgs = JSON.parse(JSON.stringify(args))

      malformedArgs.extDataHash = toFixedHex('0xdeadbeef')
      await miner.withdraw(proof, malformedArgs).should.be.rejectedWith('Incorrect external data hash')

      malformedArgs.extDataHash = toFixedHex('0x00')
      await miner.withdraw(proof, malformedArgs).should.be.rejectedWith('Incorrect external data hash')

      const balanceBefore = await torn.balanceOf(recipient)
      const expectedAmountInTorn = await rewardSwap.getExpectedReturn(amount)
      await miner.withdraw(proof, args)
      const balanceAfter = await torn.balanceOf(recipient)
      balanceAfter.should.be.eq.BN(balanceBefore.add(expectedAmountInTorn))
    })

    it('should reject for amount overflow', async () => {
      const { proof, args } = await controller.withdraw({ account, amount, recipient, publicKey })
      const malformedArgs = JSON.parse(JSON.stringify(args))

      malformedArgs.amount = toFixedHex(toBN(2).pow(toBN(248)))
      await miner.withdraw(proof, malformedArgs).should.be.rejectedWith('Amount value out of range')

      malformedArgs.amount = toFixedHex(toBN(2).pow(toBN(256)).sub(toBN(1)))
      await miner.withdraw(proof, malformedArgs).should.be.rejectedWith('Amount value out of range')

      const balanceBefore = await torn.balanceOf(recipient)
      const expectedAmountInTorn = await rewardSwap.getExpectedReturn(amount)
      await miner.withdraw(proof, args)
      const balanceAfter = await torn.balanceOf(recipient)
      balanceAfter.should.be.eq.BN(balanceBefore.add(expectedAmountInTorn))
    })

    it('should reject for fee overflow', async () => {
      const fee = account.amount.add(toBN(5))
      const fakeAmount = toBN(-5)
      const { proof, args } = await controller.withdraw({
        account,
        amount: fakeAmount,
        recipient,
        publicKey,
        fee,
      })
      await miner.withdraw(proof, args).should.be.rejectedWith('Amount should be greater than fee')
    })

    it('should reject for unfair amount', async () => {
      const fee = toBN(3)
      const amountToWithdraw = amount.sub(fee)
      const { proof, args } = await controller.withdraw({
        account,
        amount: amountToWithdraw,
        recipient,
        publicKey,
      })
      const malformedArgs = JSON.parse(JSON.stringify(args))

      malformedArgs.amount = toFixedHex(amountToWithdraw.add(amountToWithdraw))
      await miner.withdraw(proof, malformedArgs).should.be.rejectedWith('Invalid withdrawal proof')

      await timeReset()
      const balanceBefore = await torn.balanceOf(recipient)
      const expectedAmountInTorn = await rewardSwap.getExpectedReturn(amountToWithdraw)
      await miner.withdraw(proof, args)
      const balanceAfter = await torn.balanceOf(recipient)
      balanceAfter.should.be.eq.BN(balanceBefore.add(expectedAmountInTorn))
    })

    it('can use fallback with outdated tree', async () => {
      const tmpReward = await controller.reward({ account: new Account(), note: note2, publicKey })
      await miner.reward(tmpReward.proof, tmpReward.args)

      const withdrawal = await controller.withdraw({ account, amount, recipient, publicKey })

      const tmpWithdraw = await controller.withdraw({
        account: tmpReward.account,
        amount,
        recipient,
        publicKey,
      })
      await miner.withdraw(tmpWithdraw.proof, tmpWithdraw.args)

      await miner
        .withdraw(withdrawal.proof, withdrawal.args)
        .should.be.rejectedWith('Outdated account merkle root')

      const update = await controller.treeUpdate(withdrawal.account.commitment)
      await timeReset()
      const balanceBefore = await torn.balanceOf(recipient)
      const expectedAmountInTorn = await rewardSwap.getExpectedReturn(amount)
      await miner.withdraw(withdrawal.proof, withdrawal.args, update.proof, update.args)
      const balanceAfter = await torn.balanceOf(recipient)
      balanceAfter.should.be.eq.BN(balanceBefore.add(expectedAmountInTorn))

      const rootAfter = await miner.getLastAccountRoot()
      rootAfter.should.be.equal(update.args.newRoot)
    })

    it('should reject for invalid proof', async () => {
      const tmpReward = await controller.reward({ account: new Account(), note: note2, publicKey })
      await miner.reward(tmpReward.proof, tmpReward.args)

      const withdrawal = await controller.withdraw({ account, amount, recipient, publicKey })
      const tmpWithdraw = await controller.withdraw({
        account: tmpReward.account,
        amount,
        recipient,
        publicKey,
      })

      await miner
        .withdraw(tmpWithdraw.proof, withdrawal.args)
        .should.be.rejectedWith('Invalid withdrawal proof')
    })

    it('should reject for malformed relayer and recipient address and fee', async () => {
      const fakeRelayer = accounts[6]
      const fakeRecipient = accounts[7]
      const fee = 12
      const fakeFee = 123
      const { proof, args } = await controller.withdraw({
        account,
        amount,
        recipient,
        publicKey,
        fee,
        relayer,
      })
      const malformedArgs = JSON.parse(JSON.stringify(args))

      malformedArgs.extData.recipient = fakeRecipient
      await miner.withdraw(proof, malformedArgs).should.be.rejectedWith('Incorrect external data hash')

      malformedArgs.extData.recipient = recipient
      malformedArgs.extData.relayer = fakeRelayer
      await miner.withdraw(proof, malformedArgs).should.be.rejectedWith('Incorrect external data hash')

      malformedArgs.extData.relayer = relayer
      malformedArgs.extData.fee = fakeFee
      await miner.withdraw(proof, malformedArgs).should.be.rejectedWith('Incorrect external data hash')

      const extDataHash = getExtWithdrawArgsHash({
        fee: fakeFee,
        recipient: fakeRecipient,
        relayer: fakeRelayer,
        encryptedAccount: malformedArgs.extData.encryptedAccount,
      })
      malformedArgs.extData.fee = fakeFee
      malformedArgs.extData.relayer = fakeRelayer
      malformedArgs.extData.recipient = fakeRecipient
      malformedArgs.extDataHash = extDataHash
      await miner.withdraw(proof, malformedArgs).should.be.rejectedWith('Invalid withdrawal proof')

      await timeReset()
      const balanceBefore = await torn.balanceOf(recipient)
      const expectedAmountInTorn = await rewardSwap.getExpectedReturn(amount)
      await miner.withdraw(proof, args)
      const balanceAfter = await torn.balanceOf(recipient)
      balanceAfter.should.be.eq.BN(balanceBefore.add(expectedAmountInTorn))
    })
  })

  describe('#batchReward', () => {
    it('should work', async () => {
      let account = new Account()
      const claim = await controller.reward({ account, note, publicKey })
      await miner.reward(claim.proof, claim.args)

      const { proofs, args } = await controller.batchReward({
        account: claim.account,
        notes: notes.slice(1),
        publicKey,
      })
      await miner.batchReward(args)

      account = proofs.slice(-1)[0].account
      const amount = toBN(55)
      const rewardSnark = await controller.withdraw({ account, amount, recipient, publicKey })
      await timeReset()
      const balanceBefore = await torn.balanceOf(recipient)
      const expectedAmountInTorn = await rewardSwap.getExpectedReturn(amount)
      await miner.withdraw(rewardSnark.proof, rewardSnark.args)
      const balanceAfter = await torn.balanceOf(recipient)
      balanceAfter.should.be.eq.BN(balanceBefore.add(expectedAmountInTorn))
    })
  })

  describe('#isKnownAccountRoot', () => {
    it('should work', async () => {
      const claim1 = await controller.reward({ account: new Account(), note: note1, publicKey })
      await miner.reward(claim1.proof, claim1.args)

      const claim2 = await controller.reward({ account: new Account(), note: note2, publicKey })
      await miner.reward(claim2.proof, claim2.args)

      const tree = new MerkleTree(levels, [], { hashFunction: poseidonHash2 })
      await miner.isKnownAccountRoot(toFixedHex(tree.root()), 0).should.eventually.be.true

      tree.insert(claim1.account.commitment)
      await miner.isKnownAccountRoot(toFixedHex(tree.root()), 1).should.eventually.be.true

      tree.insert(claim2.account.commitment)
      await miner.isKnownAccountRoot(toFixedHex(tree.root()), 2).should.eventually.be.true

      await miner.isKnownAccountRoot(toFixedHex(tree.root()), 1).should.eventually.be.false
      await miner.isKnownAccountRoot(toFixedHex(tree.root()), 5).should.eventually.be.false
      await miner.isKnownAccountRoot(toFixedHex(1234), 1).should.eventually.be.false
      await miner.isKnownAccountRoot(toFixedHex(0), 0).should.eventually.be.false
      await miner.isKnownAccountRoot(toFixedHex(0), 5).should.eventually.be.false
    })
  })

  describe('#setRates', () => {
    it('should reject for invalid rates', async () => {
      const bigNum = toBN(2).pow(toBN(128))
      await miner
        .setRates([{ instance: tornado, value: bigNum.toString() }], { from: governance })
        .should.be.rejectedWith('Incorrect rate')
    })
  })

  describe('#setVerifiers', () => {
    it('onlyGovernance can set new verifiers', async () => {
      const verifiers = [
        '0x0000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000002',
        '0x0000000000000000000000000000000000000003',
      ]
      await miner.setVerifiers(verifiers).should.be.rejectedWith('Only governance can perform this action')
      await miner.setVerifiers(verifiers, { from: governance })

      const rewardVerifier = await miner.rewardVerifier()
      rewardVerifier.should.be.equal(verifiers[0])
      const withdrawVerifier = await miner.withdrawVerifier()
      withdrawVerifier.should.be.equal(verifiers[1])
      const treeUpdateVerifier = await miner.treeUpdateVerifier()
      treeUpdateVerifier.should.be.equal(verifiers[2])
    })
  })

  afterEach(async () => {
    await revertSnapshot(snapshotId.result)
    // eslint-disable-next-line require-atomic-updates
    snapshotId = await takeSnapshot()
  })
})
