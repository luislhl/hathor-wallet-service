import { v4 as uuidv4 } from 'uuid';

import {
  addNewAddresses,
  addUtxos,
  createTxProposal,
  createWallet,
  generateAddresses,
  getAddressWalletInfo,
  getBlockByHeight,
  getLatestHeight,
  getTokenInformation,
  getLockedUtxoFromInputs,
  getTxProposal,
  getUnusedAddresses,
  getUtxos,
  getUtxosLockedAtHeight,
  getWallet,
  getWalletAddressDetail,
  getWalletAddresses,
  getWalletTokens,
  getWalletBalances,
  getWalletSortedValueUtxos,
  getVersionData,
  getTxOutputsBySpent,
  getTransactionsById,
  getTxsAfterHeight,
  initWalletBalance,
  initWalletTxHistory,
  markUtxosWithProposalId,
  updateTxOutputSpentBy,
  storeTokenInformation,
  unlockUtxos,
  updateAddressLockedBalance,
  updateAddressTablesWithTx,
  updateExistingAddresses,
  updateTxProposal,
  updateWalletLockedBalance,
  updateWalletStatus,
  updateWalletTablesWithTx,
  updateVersionData,
  fetchAddressTxHistorySum,
  fetchAddressBalance,
  addOrUpdateTx,
  updateTx,
  fetchTx,
  markTxsAsVoided,
  removeTxsHeight,
  rebuildAddressBalancesFromUtxos,
  markAddressTxHistoryAsVoided,
  deleteBlocksAfterHeight,
  markUtxosAsVoided,
  unspendUtxos,
  filterUtxos,
  getTxProposalInputs,
} from '@src/db';
import {
  beginTransaction,
  rollbackTransaction,
  commitTransaction,
} from '@src/db/utils';
import {
  Authorities,
  TokenBalanceMap,
  TokenInfo,
  TxProposalStatus,
  WalletStatus,
  FullNodeVersionData,
  Tx,
} from '@src/types';
import {
  closeDbConnection,
  getDbConnection,
  getUnixTimestamp,
  isAuthority,
} from '@src/utils';
import {
  ADDRESSES,
  XPUBKEY,
  addToAddressBalanceTable,
  addToAddressTable,
  addToAddressTxHistoryTable,
  addToTokenTable,
  addToUtxoTable,
  addToWalletBalanceTable,
  addToWalletTxHistoryTable,
  addToWalletTable,
  cleanDatabase,
  checkAddressBalanceTable,
  checkAddressTable,
  checkAddressTxHistoryTable,
  checkVersionDataTable,
  checkUtxoTable,
  checkWalletBalanceTable,
  checkWalletTxHistoryTable,
  createOutput,
  createInput,
  countTxOutputTable,
} from '@tests/utils';

const mysql = getDbConnection();

const addrMap = {};
for (const [index, address] of ADDRESSES.entries()) {
  addrMap[address] = index;
}

beforeEach(async () => {
  await cleanDatabase(mysql);
});

afterAll(async () => {
  await closeDbConnection(mysql);
});

test('generateAddresses', async () => {
  expect.hasAssertions();
  const maxGap = 5;
  const address0 = ADDRESSES[0];

  // check first with no addresses on database, so it should return only maxGap addresses
  let addressesInfo = await generateAddresses(mysql, XPUBKEY, maxGap);
  expect(addressesInfo.addresses).toHaveLength(maxGap);
  expect(addressesInfo.existingAddresses).toStrictEqual({});
  expect(Object.keys(addressesInfo.newAddresses)).toHaveLength(maxGap);
  expect(addressesInfo.addresses[0]).toBe(address0);

  // add first address with no transactions. As it's not used, we should still only generate maxGap addresses
  await addToAddressTable(mysql, [{
    address: address0,
    index: 0,
    walletId: null,
    transactions: 0,
  }]);
  addressesInfo = await generateAddresses(mysql, XPUBKEY, maxGap);
  expect(addressesInfo.addresses).toHaveLength(maxGap);
  expect(addressesInfo.existingAddresses).toStrictEqual({ [address0]: 0 });
  let totalLength = Object.keys(addressesInfo.addresses).length;
  let existingLength = Object.keys(addressesInfo.existingAddresses).length;
  expect(Object.keys(addressesInfo.newAddresses)).toHaveLength(totalLength - existingLength);
  expect(addressesInfo.addresses[0]).toBe(address0);

  // mark address as used and check again
  let usedIndex = 0;
  await mysql.query('UPDATE `address` SET `transactions` = ? WHERE `address` = ?', [1, address0]);
  addressesInfo = await generateAddresses(mysql, XPUBKEY, maxGap);
  expect(addressesInfo.addresses).toHaveLength(maxGap + usedIndex + 1);
  expect(addressesInfo.existingAddresses).toStrictEqual({ [address0]: 0 });
  totalLength = Object.keys(addressesInfo.addresses).length;
  existingLength = Object.keys(addressesInfo.existingAddresses).length;
  expect(Object.keys(addressesInfo.newAddresses)).toHaveLength(totalLength - existingLength);

  // add address with index 1 as used
  usedIndex = 1;
  const address1 = ADDRESSES[1];
  await addToAddressTable(mysql, [{
    address: address1,
    index: usedIndex,
    walletId: null,
    transactions: 1,
  }]);
  addressesInfo = await generateAddresses(mysql, XPUBKEY, maxGap);
  expect(addressesInfo.addresses).toHaveLength(maxGap + usedIndex + 1);
  expect(addressesInfo.existingAddresses).toStrictEqual({ [address0]: 0, [address1]: 1 });
  totalLength = Object.keys(addressesInfo.addresses).length;
  existingLength = Object.keys(addressesInfo.existingAddresses).length;
  expect(Object.keys(addressesInfo.newAddresses)).toHaveLength(totalLength - existingLength);

  // add address with index 4 as used
  usedIndex = 4;
  const address4 = ADDRESSES[4];
  await addToAddressTable(mysql, [{
    address: address4,
    index: usedIndex,
    walletId: null,
    transactions: 1,
  }]);
  addressesInfo = await generateAddresses(mysql, XPUBKEY, maxGap);
  expect(addressesInfo.addresses).toHaveLength(maxGap + usedIndex + 1);
  expect(addressesInfo.existingAddresses).toStrictEqual({ [address0]: 0, [address1]: 1, [address4]: 4 });
  totalLength = Object.keys(addressesInfo.addresses).length;
  existingLength = Object.keys(addressesInfo.existingAddresses).length;
  expect(Object.keys(addressesInfo.newAddresses)).toHaveLength(totalLength - existingLength);

  // make sure no address was skipped from being generated
  for (const [index, address] of addressesInfo.addresses.entries()) {
    expect(ADDRESSES[index]).toBe(address);
  }
}, 25000);

test('getAddressWalletInfo', async () => {
  expect.hasAssertions();
  const wallet1 = { walletId: 'wallet1', xpubkey: 'xpubkey1', maxGap: 5 };
  const wallet2 = { walletId: 'wallet2', xpubkey: 'xpubkey2', maxGap: 5 };
  const finalMap = {
    addr1: wallet1,
    addr2: wallet1,
    addr3: wallet2,
  };

  // populate address table
  for (const [address, wallet] of Object.entries(finalMap)) {
    await addToAddressTable(mysql, [{
      address,
      index: 0,
      walletId: wallet.walletId,
      transactions: 0,
    }]);
  }
  // add address that won't be requested on walletAddressMap
  await addToAddressTable(mysql, [{
    address: 'addr4',
    index: 0,
    walletId: 'wallet3',
    transactions: 0,
  }]);

  // populate wallet table
  for (const wallet of Object.values(finalMap)) {
    const entry = { id: wallet.walletId, xpubkey: wallet.xpubkey, status: WalletStatus.READY, max_gap: wallet.maxGap, created_at: 0, ready_at: 0 };
    await mysql.query('INSERT INTO `wallet` SET ? ON DUPLICATE KEY UPDATE id=id', [entry]);
  }
  // add wallet that should not be on the results
  await addToWalletTable(mysql, [['wallet3', 'xpubkey3', WalletStatus.READY, 5, 0, 0]]);

  const addressWalletMap = await getAddressWalletInfo(mysql, Object.keys(finalMap));
  expect(addressWalletMap).toStrictEqual(finalMap);
});

test('getWallet, createWallet and updateWalletStatus', async () => {
  expect.hasAssertions();
  const walletId = 'walletId';
  // if there are no entries, should return null
  let ret = await getWallet(mysql, walletId);
  expect(ret).toBeNull();

  // add entry to database
  let timestamp = getUnixTimestamp();
  const createRet = await createWallet(mysql, walletId, XPUBKEY, 5);

  // get status
  ret = await getWallet(mysql, walletId);
  expect(ret).toStrictEqual(createRet);
  expect(ret.status).toBe(WalletStatus.CREATING);
  expect(ret.xpubkey).toBe(XPUBKEY);
  expect(ret.maxGap).toBe(5);
  expect(ret.createdAt).toBeGreaterThanOrEqual(timestamp);
  expect(ret.readyAt).toBeNull();

  // update wallet status to ready
  timestamp = ret.createdAt;
  await updateWalletStatus(mysql, walletId, WalletStatus.READY);
  ret = await getWallet(mysql, walletId);
  expect(ret.status).toBe(WalletStatus.READY);
  expect(ret.xpubkey).toBe(XPUBKEY);
  expect(ret.maxGap).toBe(5);
  expect(ret.createdAt).toBe(timestamp);
  expect(ret.readyAt).toBeGreaterThanOrEqual(timestamp);
});

test('addNewAddresses', async () => {
  expect.hasAssertions();
  const walletId = 'walletId';

  // test adding empty dict
  await addNewAddresses(mysql, walletId, {});
  await expect(checkAddressTable(mysql, 0)).resolves.toBe(true);

  // add some addresses
  await addNewAddresses(mysql, walletId, addrMap);
  for (const [index, address] of ADDRESSES.entries()) {
    await expect(checkAddressTable(mysql, ADDRESSES.length, address, index, walletId, 0)).resolves.toBe(true);
  }
});

test('updateExistingAddresses', async () => {
  expect.hasAssertions();
  const walletId = 'walletId';

  // test adding empty dict
  await updateExistingAddresses(mysql, walletId, {});
  await expect(checkAddressTable(mysql, 0)).resolves.toBe(true);

  // first add some addresses to database, without walletId and index
  const newAddrMap = {};
  for (const address of ADDRESSES) {
    newAddrMap[address] = null;
  }
  await addNewAddresses(mysql, null, newAddrMap);
  for (const address of ADDRESSES) {
    await expect(checkAddressTable(mysql, ADDRESSES.length, address, null, null, 0)).resolves.toBe(true);
  }

  // now update addresses with walletId
  await updateExistingAddresses(mysql, walletId, addrMap);
  for (const [index, address] of ADDRESSES.entries()) {
    await expect(checkAddressTable(mysql, ADDRESSES.length, address, index, walletId, 0)).resolves.toBe(true);
  }
});

test('initWalletTxHistory', async () => {
  expect.hasAssertions();
  const walletId = 'walletId';
  const addr1 = 'addr1';
  const addr2 = 'addr2';
  const addr3 = 'addr3';
  const token1 = 'token1';
  const token2 = 'token2';
  const token3 = 'token3';
  const txId1 = 'txId1';
  const txId2 = 'txId2';
  const timestamp1 = 10;
  const timestamp2 = 20;

  /*
   * addr1 and addr2 belong to our wallet, while addr3 does not. We are adding this last
   * address to make sure the wallet history will only get the balance from its own addresses
   *
   * These transactions are not valid under network rules, but here we only want to test the
   * database updates and final values
   *
   * tx1:
   *  . addr1: receive 10 token1 and 7 token2 (+10 token1, +7 token2);
   *  . addr2: receive 5 token2 (+5 token2);
   *  . addr3: receive 3 token1 (+3 token1);
   * tx2:
   *  . addr1: send 1 token1 and receive 3 token3 (-1 token1, +3 token3);
   *  . addr2: send 5 token2 (-5 token2);
   *  . addr3: receive 3 token1 (+3 token1);
   *
   *  Final entries for wallet_tx_history will be:
   *    . txId1 token1 +10
   *    . txId1 token2 +12
   *    . txId2 token1 -1
   *    . txId2 token2 -5
   *    . txId2 token3 +3
   */

  // with empty addresses it shouldn't add anything
  await initWalletTxHistory(mysql, walletId, []);
  await expect(checkWalletTxHistoryTable(mysql, 0)).resolves.toBe(true);

  const entries = [
    [addr1, txId1, token1, 10, timestamp1],
    [addr1, txId1, token2, 7, timestamp1],
    [addr2, txId1, token2, 5, timestamp1],
    [addr3, txId1, token1, 3, timestamp1],
    [addr1, txId2, token1, -1, timestamp2],
    [addr1, txId2, token3, 3, timestamp2],
    [addr2, txId2, token2, -5, timestamp2],
    [addr3, txId2, token1, 3, timestamp2],
  ];
  await addToAddressTxHistoryTable(mysql, entries);

  await initWalletTxHistory(mysql, walletId, [addr1, addr2]);

  // check wallet_tx_history entries
  await expect(checkWalletTxHistoryTable(mysql, 5, walletId, token1, txId1, 10, timestamp1)).resolves.toBe(true);
  await expect(checkWalletTxHistoryTable(mysql, 5, walletId, token2, txId1, 12, timestamp1)).resolves.toBe(true);
  await expect(checkWalletTxHistoryTable(mysql, 5, walletId, token1, txId2, -1, timestamp2)).resolves.toBe(true);
  await expect(checkWalletTxHistoryTable(mysql, 5, walletId, token2, txId2, -5, timestamp2)).resolves.toBe(true);
  await expect(checkWalletTxHistoryTable(mysql, 5, walletId, token3, txId2, 3, timestamp2)).resolves.toBe(true);
});

test('initWalletBalance', async () => {
  expect.hasAssertions();
  const walletId = 'walletId';
  const addr1 = 'addr1';
  const addr2 = 'addr2';
  const addr3 = 'addr3';
  const token1 = 'token1';
  const token2 = 'token2';
  const tx1 = 'tx1';
  const tx2 = 'tx2';
  const tx3 = 'tx3';
  const ts1 = 0;
  const ts2 = 10;
  const ts3 = 20;
  const timelock = 500;

  /*
   * addr1 and addr2 belong to our wallet, while addr3 does not. We are adding this last
   * address to make sure the wallet will only get the balance from its own addresses
   */
  const historyEntries = [
    [addr1, tx1, token1, 10, ts1],
    [addr1, tx2, token1, -8, ts2],
    [addr1, tx1, token2, 5, ts1],
    [addr2, tx1, token1, 3, ts1],
    [addr2, tx3, token1, 4, ts3],
    [addr2, tx2, token2, 2, ts2],
    [addr3, tx1, token1, 1, ts1],
    [addr3, tx3, token2, 11, ts3],
  ];
  const addressEntries = [
    // address, tokenId, unlocked, locked, lockExpires, transactions
    [addr1, token1, 2, 0, null, 2, 0, 0],
    [addr1, token2, 1, 4, timelock, 1, 0, 0],
    [addr2, token1, 5, 2, null, 2, 0, 0],
    [addr2, token2, 0, 2, null, 1, 0, 0],
    [addr3, token1, 0, 1, null, 1, 0, 0],
    [addr3, token2, 10, 1, null, 1, 0, 0],
  ];

  await addToAddressTxHistoryTable(mysql, historyEntries);
  await addToAddressBalanceTable(mysql, addressEntries);

  await initWalletBalance(mysql, walletId, [addr1, addr2]);

  // check balance entries
  await expect(checkWalletBalanceTable(mysql, 2, walletId, token1, 7, 2, null, 3)).resolves.toBe(true);
  await expect(checkWalletBalanceTable(mysql, 2, walletId, token2, 1, 6, timelock, 2)).resolves.toBe(true);
});

test('updateWalletTablesWithTx', async () => {
  expect.hasAssertions();
  const walletId = 'walletId';
  const walletId2 = 'walletId2';
  const token1 = 'token1';
  const token2 = 'token2';
  const tx1 = 'txId1';
  const tx2 = 'txId2';
  const tx3 = 'txId3';
  const ts1 = 10;
  const ts2 = 20;
  const ts3 = 30;

  await addToAddressTable(mysql, [
    { address: 'addr1', index: 0, walletId, transactions: 1 },
    { address: 'addr2', index: 1, walletId, transactions: 1 },
    { address: 'addr3', index: 2, walletId, transactions: 1 },
    { address: 'addr4', index: 0, walletId: walletId2, transactions: 1 },
  ]);

  // add tx1
  const walletBalanceMap1 = {
    walletId: TokenBalanceMap.fromStringMap({ token1: { unlocked: 5, locked: 0, unlockedAuthorities: new Authorities(0b01) } }),
  };
  await updateWalletTablesWithTx(mysql, tx1, ts1, walletBalanceMap1);
  await expect(checkWalletBalanceTable(mysql, 1, walletId, token1, 5, 0, null, 1, 0b01, 0)).resolves.toBe(true);
  await expect(checkWalletTxHistoryTable(mysql, 1, walletId, token1, tx1, 5, ts1)).resolves.toBe(true);

  // add tx2
  const walletBalanceMap2 = {
    walletId: TokenBalanceMap.fromStringMap(
      {
        token1: { unlocked: -2, locked: 1, lockExpires: 500, unlockedAuthorities: new Authorities(0b11) },
        token2: { unlocked: 7, locked: 0 },
      },
    ),
  };
  await updateWalletTablesWithTx(mysql, tx2, ts2, walletBalanceMap2);
  await expect(checkWalletBalanceTable(mysql, 2, walletId, token1, 3, 1, 500, 2, 0b11, 0)).resolves.toBe(true);
  await expect(checkWalletBalanceTable(mysql, 2, walletId, token2, 7, 0, null, 1)).resolves.toBe(true);
  await expect(checkWalletTxHistoryTable(mysql, 3, walletId, token1, tx1, 5, ts1)).resolves.toBe(true);
  await expect(checkWalletTxHistoryTable(mysql, 3, walletId, token1, tx2, -1, ts2)).resolves.toBe(true);
  await expect(checkWalletTxHistoryTable(mysql, 3, walletId, token2, tx2, 7, ts2)).resolves.toBe(true);

  // add tx3
  const walletBalanceMap3 = {
    walletId: TokenBalanceMap.fromStringMap({ token1: { unlocked: 1, locked: 2, lockExpires: 200, unlockedAuthorities: new Authorities([-1, -1]) } }),
    walletId2: TokenBalanceMap.fromStringMap({ token2: { unlocked: 10, locked: 0 } }),
  };
  // the tx above removes an authority, which will trigger a "refresh" on the available authorities.
  // Let's pretend there's another utxo with some authorities as well
  await addToAddressTable(mysql, [{
    address: 'address1',
    index: 0,
    walletId,
    transactions: 1,
  }]);
  await addToAddressBalanceTable(mysql, [['address1', token1, 0, 0, null, 1, 0b10, 0]]);

  await updateWalletTablesWithTx(mysql, tx3, ts3, walletBalanceMap3);
  await expect(checkWalletBalanceTable(mysql, 3, walletId, token1, 4, 3, 200, 3, 0b10, 0)).resolves.toBe(true);
  await expect(checkWalletBalanceTable(mysql, 3, walletId, token2, 7, 0, null, 1)).resolves.toBe(true);
  await expect(checkWalletBalanceTable(mysql, 3, walletId2, token2, 10, 0, null, 1)).resolves.toBe(true);
  await expect(checkWalletTxHistoryTable(mysql, 5, walletId, token1, tx1, 5, ts1)).resolves.toBe(true);
  await expect(checkWalletTxHistoryTable(mysql, 5, walletId, token1, tx2, -1, ts2)).resolves.toBe(true);
  await expect(checkWalletTxHistoryTable(mysql, 5, walletId, token2, tx2, 7, ts2)).resolves.toBe(true);
  await expect(checkWalletTxHistoryTable(mysql, 5, walletId, token1, tx3, 3, ts3)).resolves.toBe(true);
  await expect(checkWalletTxHistoryTable(mysql, 5, walletId2, token2, tx3, 10, ts3)).resolves.toBe(true);
});

test('addUtxos, getUtxos, unlockUtxos, updateTxOutputSpentBy, unspendUtxos, getTxOutputsBySpent and markUtxosAsVoided', async () => {
  expect.hasAssertions();

  const txId = 'txId';
  const utxos = [
    { value: 5, address: 'address1', tokenId: 'token1', locked: false },
    { value: 15, address: 'address1', tokenId: 'token1', locked: false },
    { value: 25, address: 'address2', tokenId: 'token2', timelock: 500, locked: true },
    { value: 35, address: 'address2', tokenId: 'token1', locked: false },
    // authority utxo
    { value: 0b11, address: 'address1', tokenId: 'token1', locked: false, tokenData: 129 },
  ];

  // empty list should be fine
  await addUtxos(mysql, txId, []);

  // add to utxo table
  const outputs = utxos.map((utxo) => createOutput(utxo.value, utxo.address, utxo.tokenId, utxo.timelock || null, utxo.locked, utxo.tokenData || 0));
  await addUtxos(mysql, txId, outputs);

  for (const [index, output] of outputs.entries()) {
    let { value } = output;
    const { token, decoded } = output;
    let authorities = 0;
    if (isAuthority(output.token_data)) {
      authorities = value;
      value = 0;
    }
    await expect(
      checkUtxoTable(mysql, utxos.length, txId, index, token, decoded.address, value, authorities, decoded.timelock, null, output.locked),
    ).resolves.toBe(true);
  }

  // getUtxos
  let results = await getUtxos(mysql, utxos.map((_utxo, index) => ({ txId, index })));
  expect(results).toHaveLength(utxos.length);
  // fetch only 2
  results = await getUtxos(mysql, [{ txId, index: 0 }, { txId, index: 1 }]);
  expect(results).toHaveLength(2);

  // empty list should be fine
  await unlockUtxos(mysql, []);

  // remove from utxo table
  const inputs = utxos.map((utxo, index) => createInput(utxo.value, utxo.address, txId, index, utxo.tokenId, utxo.timelock));
  await updateTxOutputSpentBy(mysql, inputs, txId);
  await expect(checkUtxoTable(mysql, 0)).resolves.toBe(true);

  const spentTxOutputs = await getTxOutputsBySpent(mysql, [txId]);
  expect(spentTxOutputs).toHaveLength(5);

  const txOutputs = utxos.map((utxo, index) => ({
    ...utxo,
    txId,
    authorities: 0,
    heightlock: null,
    timelock: null,
    index,
  }));

  await unspendUtxos(mysql, txOutputs);

  for (const [index, output] of outputs.entries()) {
    let { value } = output;
    const { token, decoded } = output;
    let authorities = 0;
    if (isAuthority(output.token_data)) {
      authorities = value;
      value = 0;
    }
    await expect(
      checkUtxoTable(mysql, utxos.length, txId, index, token, decoded.address, value, authorities, decoded.timelock, null, output.locked),
    ).resolves.toBe(true);
  }

  // unlock the locked one
  const first = {
    txId,
    index: 2,
    tokenId: 'token2',
    address: 'address2',
    value: 25,
    authorities: 0,
    timelock: 500,
    heightlock: null,
    locked: true,
  };
  await unlockUtxos(mysql, [first]);
  await expect(checkUtxoTable(
    mysql, utxos.length, first.txId, first.index, first.tokenId, first.address, first.value, 0, first.timelock, first.heightlock, false,
  )).resolves.toBe(true);

  const countBeforeDelete = await countTxOutputTable(mysql);
  expect(countBeforeDelete).toStrictEqual(5);

  await markUtxosAsVoided(mysql, txOutputs);

  const countAfterDelete = await countTxOutputTable(mysql);
  expect(countAfterDelete).toStrictEqual(0);
});

test('getLockedUtxoFromInputs', async () => {
  expect.hasAssertions();
  const txId = 'txId';
  const utxos = [
    { value: 5, address: 'address1', token: 'token1', locked: false },
    { value: 25, address: 'address2', token: 'token2', timelock: 500, locked: true },
    { value: 35, address: 'address2', token: 'token1', locked: false },
  ];

  // add to utxo table
  const outputs = utxos.map((utxo) => createOutput(utxo.value, utxo.address, utxo.token, utxo.timelock || null, utxo.locked));
  await addUtxos(mysql, txId, outputs);
  for (const [index, output] of outputs.entries()) {
    const { token, decoded, value } = output;
    await expect(checkUtxoTable(mysql, 3, txId, index, token, decoded.address, value, 0, decoded.timelock, null, output.locked)).resolves.toBe(true);
  }

  const inputs = utxos.map((utxo, index) => createInput(utxo.value, utxo.address, txId, index, utxo.token, utxo.timelock));
  const results = await getLockedUtxoFromInputs(mysql, inputs);
  expect(results).toHaveLength(1);
  expect(results[0].value).toBe(25);
});

test('updateAddressTablesWithTx', async () => {
  expect.hasAssertions();
  const address1 = 'address1';
  const address2 = 'address2';
  const token1 = 'token1';
  const token2 = 'token2';
  const token3 = 'token3';
  // we'll add address1 to the address table already, as if it had already received another transaction
  await addToAddressTable(mysql, [
    { address: address1, index: null, walletId: null, transactions: 1 },
  ]);

  const txId1 = 'txId1';
  const timestamp1 = 10;
  const addrMap1 = {
    address1: TokenBalanceMap.fromStringMap({
      token1: { unlocked: 10, locked: 0 },
      token2: { unlocked: 7, locked: 0 },
      token3: { unlocked: 2, locked: 0, unlockedAuthorities: new Authorities(0b01) },
    }),
    address2: TokenBalanceMap.fromStringMap({ token1: { unlocked: 8, locked: 0, unlockedAuthorities: new Authorities(0b01) } }),
  };

  await updateAddressTablesWithTx(mysql, txId1, timestamp1, addrMap1);
  await expect(checkAddressTable(mysql, 2, address1, null, null, 2)).resolves.toBe(true);
  await expect(checkAddressTable(mysql, 2, address2, null, null, 1)).resolves.toBe(true);
  await expect(checkAddressBalanceTable(mysql, 4, address1, token1, 10, 0, null, 1)).resolves.toBe(true);
  await expect(checkAddressBalanceTable(mysql, 4, address1, token2, 7, 0, null, 1)).resolves.toBe(true);
  await expect(checkAddressBalanceTable(mysql, 4, address1, token3, 2, 0, null, 1, 0b01, 0)).resolves.toBe(true);
  await expect(checkAddressBalanceTable(mysql, 4, address2, token1, 8, 0, null, 1, 0b01, 0)).resolves.toBe(true);
  await expect(checkAddressTxHistoryTable(mysql, 4, address1, txId1, token1, 10, timestamp1)).resolves.toBe(true);
  await expect(checkAddressTxHistoryTable(mysql, 4, address1, txId1, token2, 7, timestamp1)).resolves.toBe(true);
  await expect(checkAddressTxHistoryTable(mysql, 4, address1, txId1, token3, 2, timestamp1)).resolves.toBe(true);
  await expect(checkAddressTxHistoryTable(mysql, 4, address2, txId1, token1, 8, timestamp1)).resolves.toBe(true);

  // this tx removes an authority for address1,token3
  const txId2 = 'txId2';
  const timestamp2 = 15;
  const addrMap2 = {
    address1: TokenBalanceMap.fromStringMap({ token1: { unlocked: -5, locked: 0 },
      token3: { unlocked: 6, locked: 0, unlockedAuthorities: new Authorities([-1]) } }),
    address2: TokenBalanceMap.fromStringMap({ token1: { unlocked: 8, locked: 0, unlockedAuthorities: new Authorities(0b10) },
      token2: { unlocked: 3, locked: 0 } }),
  };

  await updateAddressTablesWithTx(mysql, txId2, timestamp2, addrMap2);
  await expect(checkAddressTable(mysql, 2, address1, null, null, 3)).resolves.toBe(true);
  await expect(checkAddressTable(mysql, 2, address2, null, null, 2)).resolves.toBe(true);
  // final balance for each (address,token)
  await expect(checkAddressBalanceTable(mysql, 5, address1, 'token1', 5, 0, null, 2)).resolves.toBe(true);
  await expect(checkAddressBalanceTable(mysql, 5, address1, 'token2', 7, 0, null, 1)).resolves.toBe(true);
  await expect(checkAddressBalanceTable(mysql, 5, address1, 'token3', 8, 0, null, 2, 0, 0)).resolves.toBe(true);
  await expect(checkAddressBalanceTable(mysql, 5, address2, 'token1', 16, 0, null, 2, 0b11, 0)).resolves.toBe(true);
  await expect(checkAddressBalanceTable(mysql, 5, address2, 'token2', 3, 0, null, 1)).resolves.toBe(true);
  // tx history
  await expect(checkAddressTxHistoryTable(mysql, 8, address1, txId2, token1, -5, timestamp2)).resolves.toBe(true);
  await expect(checkAddressTxHistoryTable(mysql, 8, address1, txId2, token3, 6, timestamp2)).resolves.toBe(true);
  await expect(checkAddressTxHistoryTable(mysql, 8, address2, txId2, token1, 8, timestamp2)).resolves.toBe(true);
  await expect(checkAddressTxHistoryTable(mysql, 8, address2, txId2, token2, 3, timestamp2)).resolves.toBe(true);
  // make sure entries in address_tx_history from txId1 haven't been changed
  await expect(checkAddressTxHistoryTable(mysql, 8, address1, txId1, token1, 10, timestamp1)).resolves.toBe(true);
  await expect(checkAddressTxHistoryTable(mysql, 8, address1, txId1, token2, 7, timestamp1)).resolves.toBe(true);
  await expect(checkAddressTxHistoryTable(mysql, 8, address1, txId1, token3, 2, timestamp1)).resolves.toBe(true);
  await expect(checkAddressTxHistoryTable(mysql, 8, address2, txId1, token1, 8, timestamp1)).resolves.toBe(true);

  // a tx with timelock
  const txId3 = 'txId3';
  const timestamp3 = 20;
  const lockExpires = 5000;
  const addrMap3 = {
    address1: TokenBalanceMap.fromStringMap({ token1: { unlocked: 0, locked: 3, lockExpires } }),
  };
  await updateAddressTablesWithTx(mysql, txId3, timestamp3, addrMap3);
  await expect(checkAddressBalanceTable(mysql, 5, address1, 'token1', 5, 3, lockExpires, 3)).resolves.toBe(true);

  // another tx, with higher timelock
  const txId4 = 'txId4';
  const timestamp4 = 25;
  const addrMap4 = {
    address1: TokenBalanceMap.fromStringMap({ token1: { unlocked: 0, locked: 2, lockExpires: lockExpires + 1 } }),
  };
  await updateAddressTablesWithTx(mysql, txId4, timestamp4, addrMap4);
  await expect(checkAddressBalanceTable(mysql, 5, address1, 'token1', 5, 5, lockExpires, 4)).resolves.toBe(true);

  // another tx, with lower timelock
  const txId5 = 'txId5';
  const timestamp5 = 25;
  const addrMap5 = {
    address1: TokenBalanceMap.fromStringMap({ token1: { unlocked: 0, locked: 2, lockExpires: lockExpires - 1 } }),
  };
  await updateAddressTablesWithTx(mysql, txId5, timestamp5, addrMap5);
  await expect(checkAddressBalanceTable(mysql, 5, address1, 'token1', 5, 7, lockExpires - 1, 5)).resolves.toBe(true);
});

test('getWalletTokens', async () => {
  expect.hasAssertions();
  const wallet1 = 'wallet1';
  const wallet2 = 'wallet2';

  await addToWalletTxHistoryTable(mysql, [
    [wallet1, 'tx1', '00', 5, 1000, false],
    [wallet1, 'tx1', 'token2', 70, 1000, false],
    [wallet1, 'tx2', 'token3', 10, 1001, false],
    [wallet1, 'tx3', 'token4', 25, 1001, false],
    [wallet1, 'tx4', 'token2', 30, 1001, false],
    [wallet2, 'tx5', '00', 35, 1001, false],
    [wallet2, 'tx6', 'token2', 31, 1001, false],
  ]);

  const wallet1Tokens = await getWalletTokens(mysql, wallet1);
  const wallet2Tokens = await getWalletTokens(mysql, wallet2);

  expect(wallet1Tokens).toHaveLength(4);
  expect(wallet2Tokens).toHaveLength(2);
});

test('getWalletAddresses', async () => {
  expect.hasAssertions();
  const walletId = 'walletId';
  const lastIndex = 5;
  // add some addresses into db
  const entries = [];
  for (let i = 0; i < lastIndex; i++) {
    entries.push({
      address: ADDRESSES[i],
      index: i,
      walletId,
      transactions: 0,
    });
  }
  // add entry to beginning of array, to test if method will return addresses ordered
  entries.unshift({
    address: ADDRESSES[lastIndex],
    index: lastIndex,
    walletId,
    transactions: 0,
  });
  await addToAddressTable(mysql, entries);

  const returnedAddresses = await getWalletAddresses(mysql, walletId);
  expect(returnedAddresses).toHaveLength(lastIndex + 1);
  for (const [i, address] of returnedAddresses.entries()) {
    expect(i).toBe(address.index);
    expect(address.address).toBe(ADDRESSES[i]);
  }
});

test('getWalletAddressDetail', async () => {
  expect.hasAssertions();
  const walletId = 'walletId';
  const lastIndex = 5;
  // add some addresses into db
  const entries = [];
  for (let i = 0; i < lastIndex; i++) {
    entries.push({
      address: ADDRESSES[i],
      index: i,
      walletId,
      transactions: 0,
    });
  }
  await addToAddressTable(mysql, entries);

  const detail0 = await getWalletAddressDetail(mysql, walletId, ADDRESSES[0]);
  expect(detail0.address).toBe(ADDRESSES[0]);
  expect(detail0.index).toBe(0);
  expect(detail0.transactions).toBe(0);

  const detail3 = await getWalletAddressDetail(mysql, walletId, ADDRESSES[3]);
  expect(detail3.address).toBe(ADDRESSES[3]);
  expect(detail3.index).toBe(3);
  expect(detail3.transactions).toBe(0);

  const detailNull = await getWalletAddressDetail(mysql, walletId, ADDRESSES[8]);
  expect(detailNull).toBeNull();
});

test('getWalletBalances', async () => {
  expect.hasAssertions();
  const walletId = 'walletId';
  const token1 = new TokenInfo('token1', 'MyToken1', 'MT1');
  const token2 = new TokenInfo('token2', 'MyToken2', 'MT2');
  const now = 1000;
  // add some balances into db

  await addToWalletBalanceTable(mysql, [{
    walletId,
    tokenId: token1.id,
    unlockedBalance: 10,
    lockedBalance: 4,
    unlockedAuthorities: 0,
    lockedAuthorities: 0,
    timelockExpires: now,
    transactions: 1,
  }, {
    walletId,
    tokenId: token2.id,
    unlockedBalance: 20,
    lockedBalance: 5,
    unlockedAuthorities: 0,
    lockedAuthorities: 0,
    timelockExpires: now,
    transactions: 2,
  }, {
    walletId: 'otherId',
    tokenId: token1.id,
    unlockedBalance: 30,
    lockedBalance: 1,
    unlockedAuthorities: 0,
    lockedAuthorities: 0,
    timelockExpires: now,
    transactions: 3,
  }]);

  await addToTokenTable(mysql, [
    { id: token1.id, name: token1.name, symbol: token1.symbol },
    { id: token2.id, name: token2.name, symbol: token2.symbol },
  ]);

  // first test fetching all tokens
  let returnedBalances = await getWalletBalances(mysql, walletId);
  expect(returnedBalances).toHaveLength(2);
  for (const balance of returnedBalances) {
    if (balance.token.id === token1.id) {
      expect(balance.token).toStrictEqual(token1);
      expect(balance.balance.unlockedAmount).toBe(10);
      expect(balance.balance.lockedAmount).toBe(4);
      expect(balance.balance.lockExpires).toBe(now);
      expect(balance.transactions).toBe(1);
    } else {
      expect(balance.token).toStrictEqual(token2);
      expect(balance.balance.unlockedAmount).toBe(20);
      expect(balance.balance.lockedAmount).toBe(5);
      expect(balance.transactions).toBe(2);
      expect(balance.balance.lockExpires).toBe(now);
    }
  }

  // fetch both tokens explicitly
  returnedBalances = await getWalletBalances(mysql, walletId, [token1.id, token2.id]);
  expect(returnedBalances).toHaveLength(2);

  // fetch only balance for token2
  returnedBalances = await getWalletBalances(mysql, walletId, [token2.id]);
  expect(returnedBalances).toHaveLength(1);
  expect(returnedBalances[0].token).toStrictEqual(token2);
  expect(returnedBalances[0].balance.unlockedAmount).toBe(20);
  expect(returnedBalances[0].balance.lockedAmount).toBe(5);
  expect(returnedBalances[0].balance.lockExpires).toBe(now);
  expect(returnedBalances[0].transactions).toBe(2);

  // fetch balance for non existing token
  returnedBalances = await getWalletBalances(mysql, walletId, ['otherToken']);
  expect(returnedBalances).toHaveLength(0);
});

test('getUtxosLockedAtHeight', async () => {
  expect.hasAssertions();

  const txId = 'txId';
  const txId2 = 'txId2';
  const utxos = [
    // no locks
    { value: 5, address: 'address1', token: 'token1', locked: false },
    // only timelock
    { value: 25, address: 'address2', token: 'token2', timelock: 50, locked: false },

  ];
  const utxos2 = [
    // only heightlock
    { value: 35, address: 'address2', token: 'token1', timelock: null, locked: true },
    // timelock and heightlock
    { value: 45, address: 'address2', token: 'token1', timelock: 100, locked: true },
    { value: 55, address: 'address2', token: 'token1', timelock: 1000, locked: true },
  ];

  // add to utxo table
  const outputs = utxos.map((utxo) => createOutput(utxo.value, utxo.address, utxo.token, utxo.timelock, utxo.locked));
  await addUtxos(mysql, txId, outputs, null);
  const outputs2 = utxos2.map((utxo) => createOutput(utxo.value, utxo.address, utxo.token, utxo.timelock, utxo.locked));
  await addUtxos(mysql, txId2, outputs2, 10);

  // fetch on timestamp=99 and heightlock=10. Should return:
  // { value: 35, address: 'address2', token: 'token1', timelock: null},
  let results = await getUtxosLockedAtHeight(mysql, 99, 10);
  expect(results).toHaveLength(1);
  expect(results[0].value).toBe(35);

  // fetch on timestamp=100 and heightlock=10. Should return:
  // { value: 35, address: 'address2', token: 'token1', timelock: null},
  // { value: 45, address: 'address2', token: 'token1', timelock: 100},
  results = await getUtxosLockedAtHeight(mysql, 100, 10);
  expect(results).toHaveLength(2);
  expect([35, 45]).toContain(results[0].value);
  expect([35, 45]).toContain(results[1].value);

  // fetch on timestamp=100 and heightlock=9. Should return empty
  results = await getUtxosLockedAtHeight(mysql, 1000, 9);
  expect(results).toStrictEqual([]);

  // unlockedHeight < 0. This means the block is still very early after genesis and no blocks have been unlocked
  results = await getUtxosLockedAtHeight(mysql, 1000, -2);
  expect(results).toStrictEqual([]);
});

test('updateAddressLockedBalance', async () => {
  expect.hasAssertions();

  const addr1 = 'address1';
  const addr2 = 'address2';
  const tokenId = 'tokenId';
  const otherToken = 'otherToken';
  const entries = [
    [addr1, tokenId, 50, 20, null, 3, 0, 0b01],
    [addr2, tokenId, 0, 5, null, 1, 0, 0],
    [addr1, otherToken, 5, 5, null, 1, 0, 0],
  ];
  await addToAddressBalanceTable(mysql, entries);

  const addr1Map = TokenBalanceMap.fromStringMap({ [tokenId]: { unlocked: 10, locked: 0, unlockedAuthorities: new Authorities(0b01) } });
  const addr2Map = TokenBalanceMap.fromStringMap({ [tokenId]: { unlocked: 5, locked: 0 } });
  await updateAddressLockedBalance(mysql, { [addr1]: addr1Map, [addr2]: addr2Map });
  await expect(checkAddressBalanceTable(mysql, 3, addr1, tokenId, 60, 10, null, 3, 0b01, 0)).resolves.toBe(true);
  await expect(checkAddressBalanceTable(mysql, 3, addr2, tokenId, 5, 0, null, 1)).resolves.toBe(true);
  await expect(checkAddressBalanceTable(mysql, 3, addr1, otherToken, 5, 5, null, 1)).resolves.toBe(true);

  // now pretend there's another locked authority, so final balance of locked authorities should be updated accordingly
  await addToUtxoTable(mysql, [['txId', 0, tokenId, addr1, 0, 0b01, 10000, null, true]]);
  const newMap = TokenBalanceMap.fromStringMap({ [tokenId]: { unlocked: 0, locked: 0, unlockedAuthorities: new Authorities(0b10) } });
  await updateAddressLockedBalance(mysql, { [addr1]: newMap });
  await expect(checkAddressBalanceTable(mysql, 3, addr1, tokenId, 60, 10, null, 3, 0b11, 0b01)).resolves.toBe(true);
});

test('updateWalletLockedBalance', async () => {
  expect.hasAssertions();

  const wallet1 = 'wallet1';
  const wallet2 = 'wallet2';
  const tokenId = 'tokenId';
  const otherToken = 'otherToken';
  const now = 1000;

  const entries = [{
    walletId: wallet1,
    tokenId,
    unlockedBalance: 10,
    lockedBalance: 20,
    unlockedAuthorities: 0b01,
    lockedAuthorities: 0,
    timelockExpires: now,
    transactions: 5,
  }, {
    walletId: wallet2,
    tokenId,
    unlockedBalance: 0,
    lockedBalance: 100,
    unlockedAuthorities: 0,
    lockedAuthorities: 0,
    timelockExpires: now,
    transactions: 4,
  }, {
    walletId: wallet1,
    tokenId: otherToken,
    unlockedBalance: 1,
    lockedBalance: 2,
    unlockedAuthorities: 0,
    lockedAuthorities: 0,
    timelockExpires: null,
    transactions: 1,
  }];
  await addToWalletBalanceTable(mysql, entries);

  const wallet1Map = TokenBalanceMap.fromStringMap({ [tokenId]: { unlocked: 15, locked: 0, unlockedAuthorities: new Authorities(0b11) } });
  const wallet2Map = TokenBalanceMap.fromStringMap({ [tokenId]: { unlocked: 50, locked: 0 } });
  await updateWalletLockedBalance(mysql, { [wallet1]: wallet1Map, [wallet2]: wallet2Map });
  await expect(checkWalletBalanceTable(mysql, 3, wallet1, tokenId, 25, 5, now, 5, 0b11, 0)).resolves.toBe(true);
  await expect(checkWalletBalanceTable(mysql, 3, wallet2, tokenId, 50, 50, now, 4)).resolves.toBe(true);
  await expect(checkWalletBalanceTable(mysql, 3, wallet1, otherToken, 1, 2, null, 1)).resolves.toBe(true);

  // now pretend there's another locked authority, so final balance of locked authorities should be updated accordingly
  await addToAddressTable(mysql, [{
    address: 'address1',
    index: 0,
    walletId: wallet1,
    transactions: 1,
  }]);
  await addToAddressBalanceTable(mysql, [['address1', tokenId, 0, 0, null, 1, 0, 0b01]]);
  const newMap = TokenBalanceMap.fromStringMap({ [tokenId]: { unlocked: 0, locked: 0, unlockedAuthorities: new Authorities(0b10) } });
  await updateWalletLockedBalance(mysql, { [wallet1]: newMap });
  await expect(checkWalletBalanceTable(mysql, 3, wallet1, tokenId, 25, 5, now, 5, 0b11, 0b01)).resolves.toBe(true);
});

test('updateTx should add height to a tx', async () => {
  expect.hasAssertions();

  await addOrUpdateTx(mysql, 'txId1', null, 1, 1);
  await updateTx(mysql, 'txId1', 5, 1, 1);

  const txs = await getTransactionsById(mysql, ['txId1']);
  const tx = txs[0];

  expect(tx.txId).toStrictEqual('txId1');
  expect(tx.height).toStrictEqual(5);
});

test('getLatestHeight, getTxsAfterHeight, deleteBlocksAfterHeight and removeTxsHeight', async () => {
  expect.hasAssertions();

  await addOrUpdateTx(mysql, 'txId0', 0, 1, 0);

  expect(await getLatestHeight(mysql)).toBe(0);

  await addOrUpdateTx(mysql, 'txId5', 5, 2, 0);

  expect(await getLatestHeight(mysql)).toBe(5);

  await addOrUpdateTx(mysql, 'txId7', 7, 3, 0);

  expect(await getLatestHeight(mysql)).toBe(7);

  await addOrUpdateTx(mysql, 'txId8', 8, 4, 0);
  await addOrUpdateTx(mysql, 'txId9', 9, 5, 0);
  await addOrUpdateTx(mysql, 'txId10', 10, 6, 0);

  const txsAfterHeight = await getTxsAfterHeight(mysql, 6);

  expect(txsAfterHeight).toHaveLength(4);

  expect(await getLatestHeight(mysql)).toBe(10);

  await deleteBlocksAfterHeight(mysql, 7);

  expect(await getLatestHeight(mysql)).toBe(7);

  // add the transactions again
  await addOrUpdateTx(mysql, 'txId8', 8, 4, 0);
  await addOrUpdateTx(mysql, 'txId9', 9, 5, 0);
  await addOrUpdateTx(mysql, 'txId10', 10, 6, 0);

  // remove their height
  const transactions = await getTransactionsById(mysql, ['txId8', 'txId9', 'txId10']);
  await removeTxsHeight(mysql, transactions);

  expect(await getLatestHeight(mysql)).toBe(7);
});

test('getLatestHeight with no blocks on database should return 0', async () => {
  expect.hasAssertions();

  expect(await getLatestHeight(mysql)).toBe(0);
});

test('getBlockByHeight should return null if a block is not found', async () => {
  expect.hasAssertions();

  expect(await getBlockByHeight(mysql, 100000)).toBeNull();
});

test('storeTokenInformation and getTokenInformation', async () => {
  expect.hasAssertions();

  expect(await getTokenInformation(mysql, 'invalid')).toBeNull();

  const info = new TokenInfo('tokenId', 'tokenName', 'TKNS');
  storeTokenInformation(mysql, info.id, info.name, info.symbol);

  expect(info).toStrictEqual(await getTokenInformation(mysql, info.id));
});

test('getWalletSortedValueUtxos', async () => {
  expect.hasAssertions();

  const addr1 = 'addr1';
  const addr2 = 'addr2';
  const walletId = 'walletId';
  const tokenId = 'tokenId';
  const txId = 'txId';
  await addToAddressTable(mysql, [{
    address: addr1,
    index: 0,
    walletId,
    transactions: 1,
  }, {
    address: addr2,
    index: 1,
    walletId,
    transactions: 1,
  }]);
  await addToUtxoTable(mysql, [
    // authority utxos should be ignored
    [txId, 0, tokenId, addr1, 0, 0b01, null, null, false],
    // locked utxos should be ignored
    [txId, 1, tokenId, addr1, 10, 0, 10000, null, true],
    // another wallet
    [txId, 2, tokenId, 'otherAddr', 10, 0, null, null, false],
    // another token
    [txId, 3, 'tokenId2', addr1, 5, 0, null, null, false],
    // these sould be fetched
    [txId, 4, tokenId, addr1, 4, 0, null, null, false],
    [txId, 5, tokenId, addr2, 1, 0, null, null, false],
    [txId, 6, tokenId, addr1, 7, 0, null, null, false],
  ]);

  const utxos = await getWalletSortedValueUtxos(mysql, walletId, tokenId);
  expect(utxos).toHaveLength(3);
  expect(utxos[0]).toStrictEqual({
    txId, index: 6, tokenId, address: addr1, value: 7, authorities: 0, timelock: null, heightlock: null, locked: false,
  });
  expect(utxos[1]).toStrictEqual({
    txId, index: 4, tokenId, address: addr1, value: 4, authorities: 0, timelock: null, heightlock: null, locked: false,
  });
  expect(utxos[2]).toStrictEqual({
    txId, index: 5, tokenId, address: addr2, value: 1, authorities: 0, timelock: null, heightlock: null, locked: false,
  });
});

test('getUnusedAddresses', async () => {
  expect.hasAssertions();

  const walletId = 'walletId';
  const walletId2 = 'walletId2';
  await addToAddressTable(mysql, [
    { address: 'addr2', index: 1, walletId, transactions: 0 },
    { address: 'addr3', index: 2, walletId, transactions: 2 },
    { address: 'addr1', index: 0, walletId, transactions: 0 },
    { address: 'addr4', index: 0, walletId: walletId2, transactions: 1 },
    { address: 'addr5', index: 1, walletId: walletId2, transactions: 1 },
  ]);

  let addresses = await getUnusedAddresses(mysql, walletId);
  expect(addresses).toHaveLength(2);
  expect(addresses[0]).toBe('addr1');
  expect(addresses[1]).toBe('addr2');

  addresses = await getUnusedAddresses(mysql, walletId2);
  expect(addresses).toHaveLength(0);
});

test('markUtxosWithProposalId and getTxProposalInputs', async () => {
  expect.hasAssertions();

  const txId = 'txId';
  const tokenId = 'tokenId';
  const address = 'address';
  const txProposalId = 'txProposalId';

  const utxos = [{
    txId,
    index: 0,
    tokenId,
    address,
    value: 5,
    authorities: 0,
    timelock: null,
    heightlock: null,
    locked: false,
    txProposalId: null,
    txProposalIndex: null,
  }, {
    txId,
    index: 1,
    tokenId,
    address,
    value: 15,
    authorities: 0,
    timelock: null,
    heightlock: null,
    locked: false,
    txProposalId: null,
    txProposalIndex: null,
  }, {
    txId,
    index: 2,
    tokenId,
    address,
    value: 25,
    authorities: 0,
    timelock: null,
    heightlock: null,
    locked: false,
    txProposalId: null,
    txProposalIndex: null,
  }];

  // add to utxo table
  const outputs = utxos.map((utxo) => createOutput(utxo.value, utxo.address, utxo.tokenId, utxo.timelock, utxo.locked));
  await addUtxos(mysql, txId, outputs);

  // we'll only mark utxos with indexes 0 and 2
  await markUtxosWithProposalId(mysql, txProposalId, utxos.filter((utxo) => utxo.index !== 1));
  let proposalIndex = 0;
  utxos.forEach((utxo) => {
    utxo.txProposalId = utxo.index !== 1 ? txProposalId : null;         // eslint-disable-line no-param-reassign
    utxo.txProposalIndex = utxo.index !== 1 ? proposalIndex++ : null;   // eslint-disable-line no-param-reassign
  });

  const finalUtxos = await getUtxos(mysql, utxos.map((utxo) => ({ txId, index: utxo.index })));
  expect(utxos).toStrictEqual(finalUtxos);

  // getTxProposalInputs
  // utxo with index 1 should not be returned
  const inputs = [{ txId, index: 0 }, { txId, index: 2 }];
  expect(await getTxProposalInputs(mysql, txProposalId)).toStrictEqual(inputs);
});

test('createTxProposal, updateTxProposal and getTxProposal', async () => {
  expect.hasAssertions();

  const now = getUnixTimestamp();
  const txProposalId = uuidv4();
  const walletId = 'walletId';

  await createTxProposal(mysql, txProposalId, walletId, now);
  let txProposal = await getTxProposal(mysql, txProposalId);
  expect(txProposal).toStrictEqual({ id: txProposalId, walletId, status: TxProposalStatus.OPEN, createdAt: now, updatedAt: null });

  // update
  await updateTxProposal(mysql, txProposalId, now + 7, TxProposalStatus.SENT);
  txProposal = await getTxProposal(mysql, txProposalId);
  expect(txProposal).toStrictEqual({ id: txProposalId, walletId, status: TxProposalStatus.SENT, createdAt: now, updatedAt: now + 7 });

  // tx proposal not found
  expect(await getTxProposal(mysql, 'aaa')).toBeNull();
});

test('updateVersionData', async () => {
  expect.hasAssertions();

  const mockData: FullNodeVersionData = {
    timestamp: 1614875031449,
    version: '0.38.0',
    network: 'mainnet',
    minWeight: 14,
    minTxWeight: 14,
    minTxWeightCoefficient: 1.6,
    minTxWeightK: 100,
    tokenDepositPercentage: 0.01,
    rewardSpendMinBlocks: 300,
    maxNumberInputs: 255,
    maxNumberOutputs: 255,
  };

  const mockData2: FullNodeVersionData = {
    ...mockData,
    version: '0.39.1',
  };

  const mockData3: FullNodeVersionData = {
    ...mockData,
    version: '0.39.2',
  };

  await updateVersionData(mysql, mockData);
  await updateVersionData(mysql, mockData2);
  await updateVersionData(mysql, mockData3);

  await expect(
    checkVersionDataTable(mysql, mockData3),
  ).resolves.toBe(true);
});

test('getVersionData', async () => {
  expect.hasAssertions();

  const mockData: FullNodeVersionData = {
    timestamp: 1614875031449,
    version: '0.38.0',
    network: 'mainnet',
    minWeight: 14,
    minTxWeight: 14,
    minTxWeightCoefficient: 1.6,
    minTxWeightK: 100,
    tokenDepositPercentage: 0.01,
    rewardSpendMinBlocks: 300,
    maxNumberInputs: 255,
    maxNumberOutputs: 255,
  };

  await updateVersionData(mysql, mockData);

  const versionData: FullNodeVersionData = await getVersionData(mysql);

  expect(Object.entries(versionData).toString()).toStrictEqual(Object.entries(mockData).toString());
});

test('fetchAddressTxHistorySum', async () => {
  expect.hasAssertions();

  const addr1 = 'addr1';
  const addr2 = 'addr2';
  const token1 = 'token1';
  const token2 = 'token2';
  const txId1 = 'txId1';
  const txId2 = 'txId2';
  const txId3 = 'txId3';
  const timestamp1 = 10;
  const timestamp2 = 20;
  const entries = [
    [addr1, txId1, token1, 10, timestamp1],
    [addr1, txId2, token1, 20, timestamp2],
    [addr1, txId3, token1, 30, timestamp2],
    // total: 60
    [addr2, txId1, token2, 20, timestamp1],
    [addr2, txId2, token2, 20, timestamp2],
    [addr2, txId3, token2, 10, timestamp2],
    // total: 50
  ];

  await addToAddressTxHistoryTable(mysql, entries);

  const history = await fetchAddressTxHistorySum(mysql, [addr1, addr2]);

  expect(history[0].balance).toStrictEqual(60);
  expect(history[1].balance).toStrictEqual(50);
});

test('fetchAddressBalance', async () => {
  expect.hasAssertions();

  const addr1 = 'addr1';
  const addr2 = 'addr2';
  const addr3 = 'addr3';
  const token1 = 'token1';
  const token2 = 'token2';
  const timelock = 500;

  const addressEntries = [
    // address, tokenId, unlocked, locked, lockExpires, transactions
    [addr1, token1, 2, 0, null, 2, 0, 0],
    [addr1, token2, 1, 4, timelock, 1, 0, 0],
    [addr2, token1, 5, 2, null, 2, 0, 0],
    [addr2, token2, 0, 2, null, 1, 0, 0],
    [addr3, token1, 0, 1, null, 1, 0, 0],
    [addr3, token2, 10, 1, null, 1, 0, 0],
  ];

  await addToAddressBalanceTable(mysql, addressEntries);

  const addressBalances = await fetchAddressBalance(mysql, [addr1, addr2, addr3]);

  expect(addressBalances[0].address).toStrictEqual('addr1');
  expect(addressBalances[0].tokenId).toStrictEqual('token1');
  expect(addressBalances[0].unlockedBalance).toStrictEqual(2);
  expect(addressBalances[0].lockedBalance).toStrictEqual(0);
  expect(addressBalances[1].address).toStrictEqual('addr1');
  expect(addressBalances[1].tokenId).toStrictEqual('token2');
  expect(addressBalances[1].unlockedBalance).toStrictEqual(1);
  expect(addressBalances[1].lockedBalance).toStrictEqual(4);

  expect(addressBalances[2].address).toStrictEqual('addr2');
  expect(addressBalances[2].tokenId).toStrictEqual('token1');
  expect(addressBalances[2].unlockedBalance).toStrictEqual(5);
  expect(addressBalances[2].lockedBalance).toStrictEqual(2);
  expect(addressBalances[3].address).toStrictEqual('addr2');
  expect(addressBalances[3].tokenId).toStrictEqual('token2');
  expect(addressBalances[3].unlockedBalance).toStrictEqual(0);
  expect(addressBalances[3].lockedBalance).toStrictEqual(2);

  expect(addressBalances[4].address).toStrictEqual('addr3');
  expect(addressBalances[4].tokenId).toStrictEqual('token1');
  expect(addressBalances[4].unlockedBalance).toStrictEqual(0);
  expect(addressBalances[4].lockedBalance).toStrictEqual(1);
  expect(addressBalances[5].address).toStrictEqual('addr3');
  expect(addressBalances[5].tokenId).toStrictEqual('token2');
  expect(addressBalances[5].unlockedBalance).toStrictEqual(10);
  expect(addressBalances[5].lockedBalance).toStrictEqual(1);
});

test('addTx, fetchTx, getTransactionsById and markTxsAsVoided', async () => {
  expect.hasAssertions();

  const txId1 = 'txId1';
  const txId2 = 'txId2';
  const txId3 = 'txId3';
  const txId4 = 'txId4';
  const txId5 = 'txId5';
  const timestamp = 10;

  const tx1: Tx = {
    txId: txId1,
    height: 15,
    timestamp,
    version: 0,
    voided: false,
  };

  await addOrUpdateTx(mysql, tx1.txId, tx1.height, tx1.timestamp, tx1.version);

  expect(await fetchTx(mysql, txId1)).toStrictEqual(tx1);

  const tx2 = { ...tx1, txId: txId2 };
  await addOrUpdateTx(mysql, tx2.txId, tx2.height, tx2.timestamp, tx2.version);

  const tx3 = { ...tx1, txId: txId3 };
  await addOrUpdateTx(mysql, tx3.txId, tx3.height, tx3.timestamp, tx3.version);

  const tx4 = { ...tx1, txId: txId4 };
  await addOrUpdateTx(mysql, tx4.txId, tx4.height, tx4.timestamp, tx4.version);

  const tx5 = { ...tx1, txId: txId5 };
  await addOrUpdateTx(mysql, tx5.txId, tx5.height, tx5.timestamp, tx5.version);

  const transactions = await getTransactionsById(mysql, [txId1, txId2, txId3, txId4, txId5]);

  expect(transactions).toHaveLength(5);

  await markTxsAsVoided(mysql, [tx1, tx2, tx3, tx4, tx5]);

  expect(await fetchTx(mysql, txId1)).toBeNull();
  expect(await fetchTx(mysql, txId2)).toBeNull();
  expect(await fetchTx(mysql, txId3)).toBeNull();
  expect(await fetchTx(mysql, txId4)).toBeNull();
  expect(await fetchTx(mysql, txId5)).toBeNull();
});

test('rebuildAddressBalancesFromUtxos', async () => {
  expect.hasAssertions();

  const addr1 = 'address1';
  const addr2 = 'address2';
  const txId = 'tx1';

  const utxos = [
    { value: 5, address: addr1, token: 'token1', locked: false },
    { value: 15, address: addr1, token: 'token1', locked: false },
    { value: 25, address: addr2, token: 'token2', timelock: 500, locked: true },
    { value: 35, address: addr2, token: 'token1', locked: false },
    // authority utxo
    { value: 0b11, address: addr1, token: 'token1', locked: false, tokenData: 129 },
  ];

  const outputs = utxos.map((utxo) => createOutput(utxo.value, utxo.address, utxo.token, utxo.timelock || null, utxo.locked, utxo.tokenData || 0));

  await addUtxos(mysql, txId, outputs);
  await rebuildAddressBalancesFromUtxos(mysql, ['address1', 'address2']);

  const addressBalances = await fetchAddressBalance(mysql, [addr1, addr2]);

  expect(addressBalances[0].unlockedBalance).toStrictEqual(20);
  expect(addressBalances[0].unlockedAuthorities).toStrictEqual(0b11);
  expect(addressBalances[0].address).toStrictEqual(addr1);
  expect(addressBalances[0].transactions).toStrictEqual(1);
  expect(addressBalances[0].tokenId).toStrictEqual('token1');

  expect(addressBalances[1].unlockedBalance).toStrictEqual(35);
  expect(addressBalances[1].address).toStrictEqual(addr2);
  expect(addressBalances[1].transactions).toStrictEqual(1);
  expect(addressBalances[1].tokenId).toStrictEqual('token1');

  expect(addressBalances[2].lockedBalance).toStrictEqual(25);
  expect(addressBalances[2].address).toStrictEqual(addr2);
  expect(addressBalances[2].transactions).toStrictEqual(1);
  expect(addressBalances[2].tokenId).toStrictEqual('token2');
});

test('markAddressTxHistoryAsVoided', async () => {
  expect.hasAssertions();

  const addr1 = 'address1';
  const addr2 = 'address2';
  const txId1 = 'tx1';
  const txId2 = 'tx2';
  const txId3 = 'tx3';
  const token1 = 'token1';
  const token2 = 'token2';
  const timestamp1 = 10;
  const timestamp2 = 20;

  const entries = [
    [addr1, txId1, token1, 10, timestamp1],
    [addr1, txId2, token1, 20, timestamp2],
    [addr1, txId3, token1, 30, timestamp2],
    // total: 60
    [addr2, txId1, token2, 20, timestamp1],
    [addr2, txId2, token2, 20, timestamp2],
    [addr2, txId3, token2, 10, timestamp2],
    // total: 50
  ];

  await addToAddressTxHistoryTable(mysql, entries);

  const history = await fetchAddressTxHistorySum(mysql, [addr1, addr2]);

  expect(history).toHaveLength(2);

  await markAddressTxHistoryAsVoided(mysql, [{
    txId: txId1,
    timestamp: timestamp1,
    version: 0,
    voided: false,
  }, {
    txId: txId2,
    timestamp: timestamp1,
    version: 0,
    voided: false,
  }, {
    txId: txId3,
    timestamp: timestamp1,
    version: 0,
    voided: false,
  }]);

  const history2 = await fetchAddressTxHistorySum(mysql, [addr1, addr2]);

  expect(history2).toHaveLength(0);
});

test('filterUtxos', async () => {
  expect.hasAssertions();

  const addr1 = 'addr1';
  const addr2 = 'addr2';
  const walletId = 'walletId';
  const tokenId = 'tokenId';
  const txId = 'txId';
  const txId2 = 'txId2';
  const txId3 = 'txId3';

  await addToAddressTable(mysql, [{
    address: addr1,
    index: 0,
    walletId,
    transactions: 1,
  }, {
    address: addr2,
    index: 1,
    walletId,
    transactions: 1,
  }]);

  await addToUtxoTable(mysql, [
    [txId3, 0, '00', addr1, 6000, 0, null, null, false],
    [txId, 0, tokenId, addr1, 100, 0, null, null, false],
    [txId2, 0, tokenId, addr1, 500, 0, null, null, false],
    [txId2, 1, tokenId, addr1, 1000, 0, null, null, false],
    // locked utxo:
    [txId2, 2, tokenId, addr2, 1500, 0, null, null, true],
    // authority utxo:
    [txId2, 3, tokenId, addr2, 0, 0b01, null, null, false],
    // another authority utxo:
    [txId2, 4, tokenId, addr2, 0, 0b01, null, null, false],
  ]);

  // filter all hathor utxos from addr1 and addr2
  let utxos = await filterUtxos(mysql, { addresses: [addr1, addr2] });
  expect(utxos).toHaveLength(1);

  // filter all 'tokenId' utxos from addr1 and addr2
  utxos = await filterUtxos(mysql, { addresses: [addr1, addr2], tokenId });
  expect(utxos).toHaveLength(4);

  // filter all 'tokenId' utxos from addr1 and addr2 that are not locked
  utxos = await filterUtxos(mysql, { addresses: [addr1, addr2], tokenId, ignoreLocked: true });
  expect(utxos).toHaveLength(3);

  // filter all authority utxos from addr1 and addr2
  utxos = await filterUtxos(mysql, { addresses: [addr1, addr2], tokenId, authority: 0b01 });
  expect(utxos).toHaveLength(2);

  // filter all utxos between 100 and 1500
  utxos = await filterUtxos(mysql, { addresses: [addr1, addr2], tokenId, biggerThan: 100, smallerThan: 1500 });
  expect(utxos).toHaveLength(2);
  expect(utxos[0]).toStrictEqual({
    txId: txId2,
    index: 1,
    tokenId,
    address: addr1,
    value: 1000,
    authorities: 0,
    timelock: null,
    heightlock: null,
    locked: false,
    txProposalId: null,
    txProposalIndex: null,
  });
  expect(utxos[1]).toStrictEqual({
    txId: txId2,
    index: 0,
    tokenId,
    address: addr1,
    value: 500,
    authorities: 0,
    timelock: null,
    heightlock: null,
    locked: false,
    txProposalId: null,
    txProposalIndex: null,
  });

  // limit to 2 utxos, should return the largest 2 ordered by value
  utxos = await filterUtxos(mysql, { addresses: [addr1, addr2], tokenId, maxUtxos: 2 });
  expect(utxos).toHaveLength(2);
  expect(utxos[0]).toStrictEqual({
    txId: txId2,
    index: 2,
    tokenId,
    address: addr2,
    value: 1500,
    authorities: 0,
    timelock: null,
    heightlock: null,
    locked: true,
    txProposalId: null,
    txProposalIndex: null,
  });
  expect(utxos[1]).toStrictEqual({
    txId: txId2,
    index: 1,
    tokenId,
    address: addr1,
    value: 1000,
    authorities: 0,
    timelock: null,
    heightlock: null,
    locked: false,
    txProposalId: null,
    txProposalIndex: null,
  });

  // authorities != 0 and maxUtxos == 1 should return only one authority utxo
  utxos = await filterUtxos(mysql, { addresses: [addr1, addr2], biggerThan: 0, smallerThan: 3, authority: 1, tokenId, maxUtxos: 1 });

  expect(utxos).toHaveLength(1);
});

test('filterUtxos should throw if addresses are empty', async () => {
  expect.hasAssertions();

  await expect(filterUtxos(mysql, { addresses: [] })).rejects.toThrow('Addresses can\'t be empty.');
});

test('beginTransaction, commitTransaction, rollbackTransaction', async () => {
  expect.hasAssertions();

  const addr1 = 'addr1';
  const addr2 = 'addr2';
  const tokenId = 'tokenId';
  const txId = 'txId';

  await beginTransaction(mysql);

  await addToUtxoTable(mysql, [
    [txId, 0, tokenId, addr1, 0, 0b01, null, null, false],
    [txId, 1, tokenId, addr1, 10, 0, 10000, null, true],
    [txId, 2, tokenId, 'otherAddr', 10, 0, null, null, false],
  ]);

  await commitTransaction(mysql);

  await expect(checkUtxoTable(mysql, 3, txId, 0, tokenId, addr1, 0, 0b01, null, null, false)).resolves.toBe(true);
  await expect(checkUtxoTable(mysql, 3, txId, 1, tokenId, addr1, 10, 0, 10000, null, true)).resolves.toBe(true);
  await expect(checkUtxoTable(mysql, 3, txId, 2, tokenId, 'otherAddr', 10, 0, null, null, false)).resolves.toBe(true);

  await beginTransaction(mysql);

  await addToUtxoTable(mysql, [
    [txId, 3, 'tokenId2', addr1, 5, 0, null, null, false],
    [txId, 4, tokenId, addr1, 4, 0, null, null, false],
    [txId, 5, tokenId, addr2, 1, 0, null, null, false],
    [txId, 6, tokenId, addr1, 7, 0, null, null, false],
  ]);

  await rollbackTransaction(mysql);

  // check if the database still has 3 elements only
  await expect(checkUtxoTable(mysql, 3, txId, 2, tokenId, 'otherAddr', 10, 0, null, null, false)).resolves.toBe(true);
});
