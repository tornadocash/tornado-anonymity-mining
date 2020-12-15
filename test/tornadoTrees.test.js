/* global artifacts, web3, contract */
require('chai').use(require('bn-chai')(web3.utils.BN)).use(require('chai-as-promised')).should()

const { takeSnapshot, revertSnapshot } = require('../scripts/ganacheHelper')
const Note = require('../src/note')
const TornadoTrees = artifacts.require('TornadoTreesMock')
const OwnableMerkleTree = artifacts.require('OwnableMerkleTree')
const Hasher2 = artifacts.require('Hasher2')
const Hasher3 = artifacts.require('Hasher3')
const { toFixedHex, poseidonHash2, poseidonHash } = require('../src/utils')
const MerkleTree = require('fixed-merkle-tree')

async function registerDeposit(note, tornadoTrees) {
  await tornadoTrees.setBlockNumber(note.depositBlock)
  await tornadoTrees.registerDeposit(note.instance, toFixedHex(note.commitment))
  return {
    instance: note.instance,
    hash: toFixedHex(note.commitment),
    block: toFixedHex(note.depositBlock),
  }
}

async function registerWithdrawal(note, tornadoTrees) {
  await tornadoTrees.setBlockNumber(note.withdrawalBlock)
  await tornadoTrees.registerWithdrawal(note.instance, toFixedHex(note.nullifierHash))
  return {
    instance: note.instance,
    hash: toFixedHex(note.nullifierHash),
    block: toFixedHex(note.withdrawalBlock),
  }
}

const levels = 16
contract('TornadoTrees', (accounts) => {
  let tornadoTrees
  let snapshotId
  let hasher2
  let hasher3
  let operator = accounts[0]
  let depositTree
  let withdrawalTree
  const instances = {
    one: '0x0000000000000000000000000000000000000001',
    two: '0x0000000000000000000000000000000000000002',
    three: '0x0000000000000000000000000000000000000003',
    four: '0x0000000000000000000000000000000000000004',
  }
  const note1 = new Note({
    instance: instances.one,
    depositBlock: 10,
    withdrawalBlock: 10 + 4 * 60 * 24,
  })
  const note2 = new Note({
    instance: instances.two,
    depositBlock: 10,
    withdrawalBlock: 10 + 2 * 4 * 60 * 24,
  })
  const note3 = new Note({
    instance: instances.three,
    depositBlock: 10,
    withdrawalBlock: 10 + 3 * 4 * 60 * 24,
  })

  before(async () => {
    hasher2 = await Hasher2.new()
    hasher3 = await Hasher3.new()
    tornadoTrees = await TornadoTrees.new(operator, hasher2.address, hasher3.address, levels)
    depositTree = await OwnableMerkleTree.at(await tornadoTrees.depositTree())
    withdrawalTree = await OwnableMerkleTree.at(await tornadoTrees.withdrawalTree())
    snapshotId = await takeSnapshot()
  })

  describe('#constructor', () => {
    it('should be initialized', async () => {
      const owner = await tornadoTrees.tornadoProxy()
      owner.should.be.equal(operator)
    })
  })

  describe('#updateRoots', () => {
    it('should work for many instances', async () => {
      const note1DepositLeaf = await registerDeposit(note1, tornadoTrees)
      const note2DepositLeaf = await registerDeposit(note2, tornadoTrees)

      const note2WithdrawalLeaf = await registerWithdrawal(note2, tornadoTrees)

      const note3DepositLeaf = await registerDeposit(note3, tornadoTrees)
      const note3WithdrawalLeaf = await registerWithdrawal(note3, tornadoTrees)

      await tornadoTrees.updateRoots(
        [note1DepositLeaf, note2DepositLeaf, note3DepositLeaf],
        [note2WithdrawalLeaf, note3WithdrawalLeaf],
      )

      const localDepositTree = new MerkleTree(levels, [], {
        hashFunction: poseidonHash2,
      })

      localDepositTree.insert(poseidonHash([note1.instance, note1.commitment, note1.depositBlock]))
      localDepositTree.insert(poseidonHash([note2.instance, note2.commitment, note2.depositBlock]))
      localDepositTree.insert(poseidonHash([note3.instance, note3.commitment, note3.depositBlock]))

      const lastDepositRoot = await depositTree.getLastRoot()
      toFixedHex(localDepositTree.root()).should.be.equal(lastDepositRoot.toString())

      const localWithdrawalTree = new MerkleTree(levels, [], {
        hashFunction: poseidonHash2,
      })
      localWithdrawalTree.insert(poseidonHash([note2.instance, note2.nullifierHash, note2.withdrawalBlock]))
      localWithdrawalTree.insert(poseidonHash([note3.instance, note3.nullifierHash, note3.withdrawalBlock]))

      const lastWithdrawalRoot = await withdrawalTree.getLastRoot()
      toFixedHex(localWithdrawalTree.root()).should.be.equal(lastWithdrawalRoot.toString())
    })
    it('should work for empty arrays', async () => {
      await tornadoTrees.updateRoots([], [])
    })
  })

  describe('#getRegisteredDeposits', () => {
    it('should work', async () => {
      const note1DepositLeaf = await registerDeposit(note1, tornadoTrees)
      let res = await tornadoTrees.getRegisteredDeposits()
      res.length.should.be.equal(1)
      // res[0].should.be.true
      await tornadoTrees.updateRoots([note1DepositLeaf], [])

      res = await tornadoTrees.getRegisteredDeposits()
      res.length.should.be.equal(0)

      await registerDeposit(note2, tornadoTrees)
      res = await tornadoTrees.getRegisteredDeposits()
      // res[0].should.be.true
    })
  })

  afterEach(async () => {
    await revertSnapshot(snapshotId.result)
    // eslint-disable-next-line require-atomic-updates
    snapshotId = await takeSnapshot()
  })
})
