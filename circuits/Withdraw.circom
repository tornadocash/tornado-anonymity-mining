include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/bitify.circom";
include "./Utils.circom";
include "./MerkleTree.circom";
include "./MerkleTreeUpdater.circom";

template Withdraw(levels, zeroLeaf) {
  // fee is included into the `amount` input
  signal input amount;
  signal input extDataHash;

  signal private input inputAmount;
  signal private input inputSecret;
  signal private input inputNullifier;
  signal         input inputRoot;
  signal private input inputPathIndices;
  signal private input inputPathElements[levels];
  signal         input inputNullifierHash;

  signal private input outputAmount;
  signal private input outputSecret;
  signal private input outputNullifier;
  signal         input outputRoot;
  signal         input outputPathIndices;
  signal private input outputPathElements[levels];
  signal         input outputCommitment;

  // Verify amount invariant
  inputAmount === outputAmount + amount;

  // Check that amounts fit into 248 bits to prevent overflow
  // Amount range is checked by the smart contract
  component inputAmountCheck = Num2Bits(248);
  component outputAmountCheck = Num2Bits(248);
  inputAmountCheck.in <== inputAmount;
  outputAmountCheck.in <== outputAmount;

  // Compute input commitment
  component inputHasher = Poseidon(3);
  inputHasher.inputs[0] <== inputAmount;
  inputHasher.inputs[1] <== inputSecret;
  inputHasher.inputs[2] <== inputNullifier;

  // Verify that input commitment exists in the tree
  component tree = MerkleTree(levels);
  tree.leaf <== inputHasher.out;
  tree.pathIndices <== inputPathIndices;
  for (var i = 0; i < levels; i++) {
    tree.pathElements[i] <== inputPathElements[i];
  }
  tree.root === inputRoot;

  // Verify input nullifier hash
  component nullifierHasher = Poseidon(1);
  nullifierHasher.inputs[0] <== inputNullifier;
  nullifierHasher.out === inputNullifierHash;

  // Compute and verify output commitment
  component outputHasher = Poseidon(3);
  outputHasher.inputs[0] <== outputAmount;
  outputHasher.inputs[1] <== outputSecret;
  outputHasher.inputs[2] <== outputNullifier;
  outputHasher.out === outputCommitment;

  // Update accounts tree with output account commitment
  component treeUpdater = MerkleTreeUpdater(levels, zeroLeaf);
  treeUpdater.oldRoot <== inputRoot;
  treeUpdater.newRoot <== outputRoot;
  treeUpdater.leaf <== outputCommitment;
  treeUpdater.pathIndices <== outputPathIndices;
  for (var i = 0; i < levels; i++) {
      treeUpdater.pathElements[i] <== outputPathElements[i];
  }

  // Add hidden signals to make sure that tampering with recipient or fee will invalidate the snark proof
  // Most likely it is not required, but it's better to stay on the safe side and it only takes 2 constraints
  // Squares are used to prevent optimizer from removing those constraints
  signal extDataHashSquare;
  extDataHashSquare <== extDataHash * extDataHash;
}

// zeroLeaf = keccak256("tornado") % FIELD_SIZE
component main = Withdraw(20, 21663839004416932945382355908790599225266501822907911457504978515578255421292);
