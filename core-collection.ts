import * as fs from 'fs';
import * as path from 'path';

import {
  mplCore, // The Metaplex Core program plugin
  fetchAssetV1, // Read asset information
  transferV1, // Transfer assets
  createCollection, // Build instructions to create collections and assets with Metaplex Core
  create, // Build instructions to create collections and assets with Metaplex Core
  fetchCollection,
  getAssetV1GpaBuilder, // Allow building program-account queries (getProgramAccounts - gPA)
  Key, // enum discriminators
  updateAuthority, // helper to construct UpdateAuthority
  ruleSet, // helper for Core plugins
  addPlugin, // helper for Core plugins
} from '@metaplex-foundation/mpl-core';
import {
  TransactionBuilderSendAndConfirmOptions,
  generateSigner, // Create new ed25519 keypairs
  signerIdentity, // sets the default signer/fee-payer for all builders
  sol, // Convenience for SOL amounts
  createSignerFromKeypair, // Used to wrap a keypair into a Umi signer
  Signer,
  Umi,
  PublicKey,
  SolAmount,
} from '@metaplex-foundation/umi';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults'; // imports createUmi which allows us to build a ready-to-use Umi client

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

// Initialize Umi with the DEVNET endpoint and 'confirmed' commitment level.
// createUmi builds a Umi client (RPC connection, codecs, Ed25519, transactions, etc.)
// Solana has different commitment levels:
// - `"processed"` - fastest, least secure (transaction processed by leader)
// - `"confirmed"` - balanced (confirmed by cluster, ~400ms)
// - `"finalized"` - slowest, most secure (confirmed by supermajority, ~13 seconds)
const umi = createUmi('https://api.devnet.solana.com', 'confirmed').use(mplCore());

// In Metaplex Core, assets/collections have their own accounts. Generate a keypair to be
// used as the address for an asset.
const asset = generateSigner(umi);

// Load a Solana wallet
const payer = loadWallet(umi);

// Set the wallet as the default identity to pay fees, rent and sign instructions.
// Instructions that don't explicitly take a signer/authority will use the default.
umi.use(signerIdentity(payer));

// Build a new transaction configuration object. This object is used to tell Umi how to broadcast
// the transaction and how to wait for confirmation.
const txConfig: TransactionBuilderSendAndConfirmOptions = {
  // When a transaction is sent to a Solana RPC node, by default it will simulate the transaction
  // before committing it on-chain. This is called the preflight check. If the preflight simulation
  // fails, the node rejects your transaction before broadcasting it. This helps catch errors early
  // without wasting fees.
  // Setting skiPreflight to true skips the simulation, but is riskier. Skipping the simulation is
  // useful when we want lower latency and overhead (mint race, trading or arbitrage bot).
  send: { skipPreflight: false },
  confirm: { commitment: 'finalized' },
};

async function transferNFT(
  umi: Umi,
  assetAddress: PublicKey,
  collectionAddress: PublicKey,
  newOwner: PublicKey,
  currentOwner?: Signer,
): Promise<number> {
  const startingBalance = await umi.rpc.getBalance(payer.publicKey);

  console.log('» Transferring NFT...');
  console.log('  Asset:', assetAddress.toString());
  console.log('  From:', currentOwner?.publicKey.toString() || payer.publicKey.toString());
  console.log('  To:', newOwner.toString());
  console.log();

  await transferV1(umi, {
    asset: assetAddress,
    collection: collectionAddress,
    newOwner: newOwner,
    authority: currentOwner || payer, // Current owner must sign the transfer
  }).sendAndConfirm(umi, txConfig);

  const finalBalance = await umi.rpc.getBalance(payer.publicKey);
  const transferCost = calculateCost(startingBalance, finalBalance);

  console.log('» Transfer completed!');
  console.log('  Transfer cost:', transferCost, 'SOL');
  console.log();

  return transferCost;
}

function calculateCost(startingBalance: SolAmount, finalBalance: SolAmount): number {
  const startingSol = Number(startingBalance.basisPoints) / 1_000_000_000;
  const finalSol = Number(finalBalance.basisPoints) / 1_000_000_000;
  return startingSol - finalSol;
}

async function main() {
  // Check wallet balance
  console.log('» Using wallet:', payer.publicKey.toString());
  let balance = await umi.rpc.getBalance(payer.publicKey);
  console.log('» Initial balance:', Number(balance.basisPoints) / 1_000_000_000, 'SOL');
  console.log();
  // Generate a keypair to be used as the address for an asset representing a collection.
  const collectionAddress = generateSigner(umi);

  console.log('» Creating collection:', collectionAddress.publicKey.toString());
  console.log();

  // Create a Core NFT collection
  await createCollection(umi, {
    name: 'Byte Spirits', // The collection's name on-chain
    // The uri points to off-chain JSON metadata that describes the asset (name, image, attributes, description)
    uri: 'https://raw.githubusercontent.com/joaotav/mpl-core/refs/heads/main/collection-data/files/metadata/byte-spirits/byte-spirits-collection.json',
    collection: collectionAddress, // The collection's account address on-chain
    // The updateAuthority defines which keypair has permission to update this collection later.
    // The update authority can add/remove plugins, change the collection's name, uri, and transfer the
    // update authority to another account or multisig. The update authority can be set to "none" in order
    // to make the collection immutable.
    updateAuthority: payer.publicKey,
    plugins: [
      {
        // Add the royalties plugin to the collection.
        type: 'Royalties',
        basisPoints: 500, // 5% royalties are generated from secondary sales
        creators: [
          // Creators among which the royalties are split
          {
            address: payer.publicKey,
            percentage: 100, // This creator/address receives 100% of the royalties
          },
        ],
        ruleSet: ruleSet('None'), // No extra rule gating
      },
    ],
  }).sendAndConfirm(umi, txConfig);

  const collection = await fetchCollection(umi, collectionAddress.publicKey);

  // Add an asset to the collection
  console.log('» Creating Asset:', asset.publicKey.toString());
  console.log();

  await create(umi, {
    name: 'Byte Spirits #1', // The asset's name on-chain
    // The asset's off-chain metadata (name, description, attributes, image)
    uri: 'https://raw.githubusercontent.com/joaotav/mpl-core/refs/heads/main/collection-data/files/metadata/byte-spirits/byte-spirits-1.json',
    asset: asset, // A Signer object for the new asset's account
    // collection defines the collection to which this asset will be linked. This individual asset's
    // update authority is automatically set to the previously set collection's update authority.
    collection: collection,
    // authority must be a key that possesses the permission to mint an asset into this collection.
    // It can be the collection's update authority or an address that has been given permission
    // to mint through delegations, rules or plugins.
    authority: payer,
    // owner is the account that will receive the minted NFT. If the owner is ommitted, the minter
    // (authority) will receive the NFT.
    owner: payer.publicKey,
  }).sendAndConfirm(umi, txConfig);

  // EXAMPLE: Transfer the NFT to a different address
  // Replace this with an actual wallet address you want to transfer to
  const recipientAddress = generateSigner(umi).publicKey; // For demo - generate a random address
  console.log('» Generated recipient address for demo:', recipientAddress.toString());
  console.log();

  // Transfer the NFT
  // await transferNFT(
  //   umi,
  //   asset.publicKey, // The asset we just created
  //   collectionAddress.publicKey, // The collection it belongs to
  //   recipientAddress, // Where to send it
  // );

  // // Verify the transfer by fetching the asset and checking the new owner
  // const transferredAsset = await fetchAssetV1(umi, asset.publicKey);
  // console.log('» Transfer verification:');
  // console.log('  New owner:', transferredAsset.owner.toString());
  // console.log('  Expected:', recipientAddress.toString());
  // console.log(
  //   '  Transfer successful:',
  //   transferredAsset.owner.toString() === recipientAddress.toString(),
  // );
  // console.log();

  balance = await umi.rpc.getBalance(payer.publicKey);
  console.log('» Final balance:', Number(balance.basisPoints) / 1_000_000_000, 'SOL');
  console.log();

  // Use the getProgramAccounts (gPA) helper to query all assets belonging to the collection
  const assetsInCollection = await getAssetV1GpaBuilder(umi)
    .whereField('key', Key.AssetV1) // Query for all asset accounts (AssetV1)
    .whereField('updateAuthority', updateAuthority('Collection', [collectionAddress.publicKey]))
    .getDeserialized();

  console.log('» Deployment summary:');
  console.log();

  for (const a of assetsInCollection) {
    console.log({
      asset: a.publicKey.toString(),
      collection: collectionAddress.publicKey.toString(),
      owner: a.owner.toString(),
      name: a.name, // present on Core assets
      uri: a.uri, // present on Core assets
    });
    console.log();
  }
}

main().catch(console.error);
