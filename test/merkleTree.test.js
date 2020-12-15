/* global artifacts, web3, contract */
require('chai').use(require('bn-chai')(web3.utils.BN)).use(require('chai-as-promised')).should()

const { takeSnapshot, revertSnapshot } = require('../scripts/ganacheHelper')
const { toFixedHex, randomBN } = require('../src/utils')
const MerkleTree = artifacts.require('MerkleTreeWithHistoryMock')
const Hasher = artifacts.require('Hasher2')

const levels = 16

contract('MerkleTree', () => {
  let tree1
  let tree2
  let snapshotId
  let hasher

  before(async () => {
    hasher = await Hasher.new()
    tree1 = await MerkleTree.new(levels, hasher.address)
    tree2 = await MerkleTree.new(levels, hasher.address)
    snapshotId = await takeSnapshot()
  })

  describe('#tree', () => {
    it('should bulk insert', async () => {
      const elements = ['123', '456', '789'].map((e) => toFixedHex(e))

      await tree1.bulkInsert(elements)
      for (const e of elements) {
        await tree2.insert(e)
      }

      const root1 = await tree1.getLastRoot()
      const root2 = await tree2.getLastRoot()

      root1.should.be.equal(root2)
    })

    it('almost full tree', async () => {
      let tree = await MerkleTree.new(3, hasher.address)
      let elements = ['1', '2', '3', '4', '5', '6', '7'].map((e) => toFixedHex(e))
      await tree.bulkInsert(elements)

      tree = await MerkleTree.new(3, hasher.address)
      elements = ['1', '2', '3', '4', '5', '6', '7', '8'].map((e) => toFixedHex(e))
      await tree.bulkInsert(elements)

      tree = await MerkleTree.new(3, hasher.address)
      elements = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((e) => toFixedHex(e))
      // prettier-ignore
      await tree
        .bulkInsert(elements)
        .should.be.rejectedWith('Merkle doesn\'t have enough capacity to add specified leaves')
    })

    // it('estimate gas hasher', async () => {
    //   const gas = await tree1.test() // hasher.contract.methods.poseidon([1, 2]).estimateGas()
    //   console.log('gas', gas.toString())
    // })

    it('should bulk insert with initial state', async () => {
      const initElements = [123, 456, 789].map((e) => toFixedHex(e))
      const elements = [12, 34, 56, 78, 90].map((e) => toFixedHex(e))

      for (const e of initElements) {
        await tree1.insert(e)
        await tree2.insert(e)
      }

      await tree1.bulkInsert(elements)
      for (const e of elements) {
        await tree2.insert(e)
      }

      const root1 = await tree1.getLastRoot()
      const root2 = await tree2.getLastRoot()

      root1.should.be.equal(root2)
    })

    it.skip('should pass the stress test', async () => {
      const rounds = 40
      const elementCount = 10

      for (let i = 0; i < rounds; i++) {
        const length = 1 + Math.floor(Math.random() * elementCount)
        const elements = Array.from({ length }, () => randomBN()).map((e) => toFixedHex(e))

        await tree1.bulkInsert(elements)
        for (const e of elements) {
          await tree2.insert(e)
        }

        const root1 = await tree1.getLastRoot()
        const root2 = await tree2.getLastRoot()

        root1.should.be.equal(root2)
      }
    })
  })

  afterEach(async () => {
    await revertSnapshot(snapshotId.result)
    // eslint-disable-next-line require-atomic-updates
    snapshotId = await takeSnapshot()
  })
})
