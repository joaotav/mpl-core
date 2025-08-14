import { createUmi } from '@metaplex-foundation/umi-bundle-defaults'
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
} from '@metaplex-foundation/mpl-core'
import { TransactionBuilderSendAndConfirmOptions, generateSigner, signerIdentity, sol, createSignerFromKeypair } from '@metaplex-foundation/umi';
import * as fs from 'fs';
import * as path from 'path';

// Initialize Umi with the DEVNET endpoint
const umi = createUmi('https://api.devnet.solana.com', 'processed').use(mplCore())

// Generate a signer for the asset
const asset = generateSigner(umi);

// Load existing wallet from file
const walletPath = path.join(process.env.HOME || process.env.USERPROFILE || '', '.config/solana/dev-wallet.json');
const walletData = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
const keypair = umi.eddsa.createKeypairFromSecretKey(new Uint8Array(walletData));
const payer = createSignerFromKeypair(umi, keypair);
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
 const balance = await umi.rpc.getBalance(payer.publicKey);
//  console.log('   Current balance:', balance.basisPoints / 1000000000, 'SOL');
 
 // Optional: Airdrop more funds if needed (uncomment if you need more SOL)
 // const airdropAmount = sol(2);
 // await umi.rpc.airdrop(payer.publicKey, airdropAmount, txConfig.confirm);

// 2. Create a collection asset
const collectionAddress = generateSigner(umi);
 console.log('2. Creating Collection:', collectionAddress.publicKey.toString());
const collectionUpdateAuthority = generateSigner(umi);
const creator1 = generateSigner(umi);
const creator2 = generateSigner(umi);



await createCollectionV1(umi, {
 name: 'Educore (EDC)', // 👈 Replace this
 uri: 'https://raw.githubusercontent.com/joaotav/collection-data/refs/heads/main/files/metadata/collection-example-2.json', // 👈 Replace this
 collection: collectionAddress,
 updateAuthority: collectionUpdateAuthority.publicKey,
 plugins: [
pluginAuthorityPair({
 type: 'Royalties',
 data: {
 basisPoints: 500,
 creators: [
 {
 address: creator1.publicKey,
 percentage: 20,
 },
 {
 address: creator2.publicKey,
 percentage: 80,
 },
 ],
 ruleSet: ruleSet('None'), // Compatibility rule set
 },
 }),
 ],
 }).sendAndConfirm(umi, txConfig);

// 3. Create an asset in a collection
 console.log('3. Creating Asset:', asset.publicKey.toString()); // 👈 Add this line
await createV1(umi, {
 name: 'Educore #1',
 uri: 'https://raw.githubusercontent.com/joaotav/collection-data/refs/heads/main/files/metadata/asset-example-2.json',
 asset: asset,
 collection: collectionAddress.publicKey,
 authority: collectionUpdateAuthority,
 }).sendAndConfirm(umi, txConfig);

 // Add plugins separately
await addPlugin(umi, {
    asset: asset.publicKey,
    plugin: {
        type: 'Attributes',
        attributeList: [
            { key: 'symbol', value: 'EDC' },
        ],
    },
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
 .whereField(
'updateAuthority',
updateAuthority('Collection', [collectionAddress.publicKey])
 )
 .getDeserialized();
 console.log(assetsByCollection);
}

main().catch(console.error);