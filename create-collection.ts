import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import {
  createV1,
  mplCore,
  fetchAssetV1,
  transferV1,
  createCollectionV1,
  getAssetV1GpaBuilder,
  Key,
  updateAuthority,
  pluginAuthorityPair,
  ruleSet,
  addPlugin,
} from '@metaplex-foundation/mpl-core';

import {
  TransactionBuilderSendAndConfirmOptions,
  generateSigner,
  signerIdentity,
  sol,
  createSignerFromKeypair,
} from '@metaplex-foundation/umi';

import * as fs from 'fs';
import * as path from 'path';

function loadLocalWallet(umi: Umi, walletPath?: string): Signer {
  const defaultWalletPath = path.join(
    process.env.HOME || process.env.USERPROFILE || '',
    '.config/solana/dev-wallet.json',
  );
  const finalWalletPath = walletPath || defaultWalletPath;

  try {
    const walletData = JSON.parse(fs.readFileSync(finalWalletPath, 'utf8'));
    const keypair = umi.eddsa.createKeypairFromSecretKey(new Uint8Array(walletData));
    return createSignerFromKeypair(umi, keypair);
  } catch (error) {
    throw new Error(`Failed to load wallet from ${finalWalletPath}: ${error}`);
  }
}

// Initialize Umi with the DEVNET endpoint and 'confirmed' commitment level.
// createUmi builds a Umi client (RPC connection, codecs, Ed25519, transactions, etc.)
// Solana has different commitment levels:
// - `"processed"` - fastest, least secure (transaction processed by leader)
// - `"confirmed"` - balanced (confirmed by cluster, ~400ms)
// - `"finalized"` - slowest, most secure (confirmed by supermajority, ~13 seconds)
const umi = createUmi('https://api.devnet.solana.com', 'confirmed').use(mplCore());

// Generate a signer for the asset
const asset = generateSigner(umi);

// Load the wallet and set is as the payer
const payer = loadLocalWallet(umi);
umi.use(signerIdentity(payer));

// Create a txConfig object
const txConfig: TransactionBuilderSendAndConfirmOptions = {
  send: { skipPreflight: true },
  confirm: { commitment: 'confirmed' },
};

async function main() {
  // 1. Check wallet balance
  console.log('1. Using wallet: ', payer.publicKey.toString());

  // Get current balance
  //  const balance = await umi.rpc.getBalance(payer.publicKey);
  //  console.log('   Current balance:', balance.basisPoints / 1000000000, 'SOL');

  // 2. Create a collection asset
  const collectionAddress = generateSigner(umi);
  console.log('2. Creating Collection:', collectionAddress.publicKey.toString());

  await createCollectionV1(umi, {
    name: 'Byte Spirits',
    uri: 'https://raw.githubusercontent.com/joaotav/mpl-core/refs/heads/main/collection-data/files/metadata/byte-spirits/byte-spirits-collection.json',
    collection: collectionAddress,
    updateAuthority: payer.publicKey,
    plugins: [
      pluginAuthorityPair({
        type: 'Royalties',
        data: {
          basisPoints: 500,
          creators: [
            {
              address: payer.publicKey,
              percentage: 100,
            },
          ],
          ruleSet: ruleSet('None'), // Compatibility rule set
        },
      }),
    ],
  }).sendAndConfirm(umi, txConfig);

  // 3. Create an asset in a collection
  console.log('3. Creating Asset:', asset.publicKey.toString());
  await createV1(umi, {
    name: 'Byte Spirits #1',
    uri: 'https://raw.githubusercontent.com/joaotav/mpl-core/refs/heads/main/collection-data/files/metadata/byte-spirits/byte-spirits-1.json',
    asset: asset,
    collection: collectionAddress.publicKey,
    authority: payer,
  }).sendAndConfirm(umi, txConfig);

  // 4. Fetch assets by owner
  const assetsByOwner = await getAssetV1GpaBuilder(umi)
    .whereField('key', Key.AssetV1)
    .whereField('owner', payer.publicKey)
    .getDeserialized();

  console.log(assetsByOwner);

  // 5. Fetch assets by collection
  const assetsByCollection = await getAssetV1GpaBuilder(umi)
    .whereField('key', Key.AssetV1)
    .whereField('updateAuthority', updateAuthority('Collection', [collectionAddress.publicKey]))
    .getDeserialized();

  console.log(assetsByCollection);
}

main().catch(console.error);
