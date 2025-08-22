import * as fs from 'fs';
import * as path from 'path';

import { createCollectionV1, createCollection, ruleSet } from '@metaplex-foundation/mpl-core';
import {
  mplCandyMachine as mplCoreCandyMachine,
  create,
  addConfigLines,
  fetchCandyMachine,
  deleteCandyMachine,
  mintV1,
} from '@metaplex-foundation/mpl-core-candy-machine';
import { setComputeUnitLimit } from '@metaplex-foundation/mpl-toolbox';
import {
  Umi,
  PublicKey,
  generateSigner,
  transactionBuilder,
  keypairIdentity,
  some,
  sol,
  dateTime,
  TransactionBuilderSendAndConfirmOptions,
  createSignerFromKeypair,
  Signer,
  signerIdentity,
} from '@metaplex-foundation/umi';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';

const umi = createUmi('https://api.devnet.solana.com', 'finalized').use(mplCoreCandyMachine());

const keypair = loadWallet(umi);
const collectionMint = generateSigner(umi);
const treasury = generateSigner(umi);
const candyMachine = generateSigner(umi);

umi.use(signerIdentity(keypair));

const txOptions: TransactionBuilderSendAndConfirmOptions = {
  send: { skipPreflight: false },
  confirm: { commitment: 'finalized' },
};

interface ExpectedCandyMachineState {
  itemsLoaded: number;
  itemsRedeemed: number;
  authority: PublicKey;
  collection: PublicKey;
}

function loadWallet(umi: Umi, walletPath?: string): Signer {
  // Looks for a wallet in walletPath if specified, otherwise loads the wallet from
  // the default location.
  const defaultWalletPath = path.join(
    process.env.HOME || process.env.USERPROFILE || '',
    '.config/solana/dev-wallet.json',
  );
  const finalWalletPath = walletPath || defaultWalletPath;

  try {
    // Expect the file to contain a standard Solana secret key export (JSON array of 64 numbers)
    // Rebuilds the ed25519 keypair and wraps it into a Umi 'Signer'
    const walletData = JSON.parse(fs.readFileSync(finalWalletPath, 'utf8'));
    const keypair = umi.eddsa.createKeypairFromSecretKey(new Uint8Array(walletData));
    return createSignerFromKeypair(umi, keypair);
  } catch (error) {
    throw new Error(`Failed to load wallet from ${finalWalletPath}: ${error}`);
  }
}

async function checkCandyMachine(
  umi: Umi,
  candyMachine: PublicKey,
  expectedCandyMachineState: ExpectedCandyMachineState,
  step?: number,
) {
  try {
    const loadedCandyMachine = await fetchCandyMachine(umi, candyMachine, txOptions.confirm);
    const { itemsLoaded, itemsRedeemed, authority, collection } = expectedCandyMachineState;
    if (Number(loadedCandyMachine.itemsRedeemed) !== itemsRedeemed) {
      throw new Error('Incorrect number of items available in the Candy Machine.');
    }
    if (loadedCandyMachine.itemsLoaded !== itemsLoaded) {
      throw new Error('Incorrect number of items loaded in the Candy Machine.');
    }
    if (loadedCandyMachine.authority.toString() !== authority.toString()) {
      throw new Error('Incorrect authority in the Candy Machine.');
    }
    if (loadedCandyMachine.collectionMint.toString() !== collection.toString()) {
      throw new Error('Incorrect collection in the Candy Machine.');
    }
    step && console.log(`${step}. ✅ - Candy Machine has the correct configuration.`);
  } catch (error) {
    if (error instanceof Error) {
      step && console.log(`${step}. ❌ - Candy Machine incorrect configuration: ${error.message}`);
    } else {
      step && console.log(`${step}. ❌ - Error fetching the Candy Machine.`);
    }
  }
}

function calculateCost(startingBalance: SolAmount, finalBalance: SolAmount): number {
  const startingSol = Number(startingBalance.basisPoints) / 1_000_000_000;
  const finalSol = Number(finalBalance.basisPoints) / 1_000_000_000;
  return startingSol - finalSol;
}

async function main() {
  console.log(`Testing Candy Machine Core...`);
  console.log(`Important account information:`);
  console.table({
    keypair: keypair.publicKey.toString(),
    collectionMint: collectionMint.publicKey.toString(),
    treasury: treasury.publicKey.toString(),
    candyMachine: candyMachine.publicKey.toString(),
  });

  // Create a collection
  try {
    await createCollection(umi, {
      collection: collectionMint,
      name: 'Byte Spirits',
      uri: 'https://raw.githubusercontent.com/joaotav/mpl-core/refs/heads/main/collection-data/files/metadata/byte-spirits/byte-spirits-collection.json',
      plugins: [
        {
          // Add the royalties plugin to the collection.
          type: 'Royalties',
          basisPoints: 500, // 5% royalties are generated from secondary sales
          creators: [
            // Creators among which the royalties are split
            {
              address: umi.identity.publicKey,
              percentage: 100, // This creator/address receives 100% of the royalties
            },
          ],
          ruleSet: ruleSet('None'), // No extra rule gating
        },
      ],
    }).sendAndConfirm(umi, txOptions);
    console.log(`2. ✅ - Created collection: ${collectionMint.publicKey.toString()}`);
  } catch (error) {
    console.log('2. ❌ - Error creating collection.');
  }

  // Create a Candy Machine
  try {
    const createIx = await create(umi, {
      candyMachine,
      collection: collectionMint.publicKey,
      collectionUpdateAuthority: umi.identity,
      itemsAvailable: 3,
      authority: umi.identity.publicKey,
      isMutable: false,
      configLineSettings: some({
        prefixName: 'Byte Spirits #$ID+1$',
        nameLength: 2,
        prefixUri:
          'https://raw.githubusercontent.com/joaotav/mpl-core/refs/heads/main/collection-data/files/metadata/byte-spirits/byte-spirits-',
        // uriLength is the maximum length for the URI of each inserted item excluding the URI prefix
        // uriLength + len(prefixUri) cannot exceed 200 characters
        uriLength: 30,
        isSequential: true,
      }),
      // guards: {
      // botTax: some({ lamports: sol(0), lastInstruction: true }),
      // solPayment: some({ lamports: sol(0), destination: umi.identity.publicKey }),
      // startDate: some({ date: dateTime('2023-04-04T16:00:00Z') }),
      // All other guards are disabled...
      // },
    });
    await createIx.sendAndConfirm(umi, txOptions);
    console.log(`3. ✅ - Created Candy Machine: ${candyMachine.publicKey.toString()}`);
  } catch (error) {
    console.log('3. ❌ - Error creating Candy Machine.');
  }

  // Add items to the Candy Machine
  try {
    await addConfigLines(umi, {
      candyMachine: candyMachine.publicKey,
      index: 0,
      configLines: [
        { name: '', uri: '1.json' },
        { name: '', uri: '2.json' },
        { name: '', uri: '3.json' },
      ],
    }).sendAndConfirm(umi, txOptions);
    console.log(`4. ✅ - Added items to the Candy Machine: ${candyMachine.publicKey.toString()}`);
  } catch (error) {
    console.log('4. ❌ - Error adding items to the Candy Machine.');
  }

  // Verify the Candy Machine configuration
  await checkCandyMachine(
    umi,
    candyMachine.publicKey,
    {
      itemsLoaded: 3,
      authority: umi.identity.publicKey,
      collection: collectionMint.publicKey,
      itemsRedeemed: 0,
    },
    5,
  );

  // Mint NFTs
  try {
    const numMints = 3;
    let minted = 0;
    for (let i = 0; i < numMints; i++) {
      const assetSigner = generateSigner(umi);

      await transactionBuilder()
        .add(setComputeUnitLimit(umi, { units: 800_000 }))
        .add(
          mintV1(umi, {
            candyMachine: candyMachine.publicKey,
            asset: assetSigner,
            collection: collectionMint.publicKey,
            mintArgs: {
              solPayment: some({ destination: treasury.publicKey }),
            },
          }),
        )
        .sendAndConfirm(umi, txOptions);
      minted++;
      console.log(`Asset Address: ${assetSigner.publicKey.toString()}`);
    }
    console.log(`6. ✅ - Minted ${minted} NFTs.`);
  } catch (error) {
    console.log('6. ❌ - Error minting NFTs.');
  }

  // Verify the Candy Machine configuration
  await checkCandyMachine(
    umi,
    candyMachine.publicKey,
    {
      itemsLoaded: 3,
      authority: umi.identity.publicKey,
      collection: collectionMint.publicKey,
      itemsRedeemed: 3,
    },
    7,
  );

  // Delete the Candy Machine
  try {
    await deleteCandyMachine(umi, {
      candyMachine: candyMachine.publicKey,
    }).sendAndConfirm(umi, txOptions);
    console.log(`8. ✅ - Deleted the Candy Machine: ${candyMachine.publicKey.toString()}`);
  } catch (error) {
    console.log('8. ❌ - Error deleting the Candy Machine.');
  }
}
main().catch(console.error);
