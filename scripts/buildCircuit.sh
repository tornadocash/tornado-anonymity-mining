#!/bin/bash
npx circom circuits/$1.circom -o build/circuits/$1.json
npx snarkjs info -c build/circuits/$1.json
zkutil setup -c build/circuits/$1.json -p build/circuits/$1.params
zkutil export-keys -c build/circuits/$1.json -p build/circuits/$1.params --pk build/circuits/$1_proving_key.json --vk build/circuits/$1_verification_key.json
node node_modules/websnark/tools/buildpkey.js -i build/circuits/$1_proving_key.json -o build/circuits/$1_proving_key.bin
zkutil generate-verifier -p build/circuits/$1.params -v build/circuits/${1}Verifier.sol
sed -i.bak "s/contract Verifier/contract ${1}Verifier/g" build/circuits/${1}Verifier.sol
