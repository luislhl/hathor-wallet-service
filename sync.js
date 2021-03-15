/* eslint-disable */

const fs = require('fs');
const readline = require('readline');
const { once } = require('events');
const WebSocket = require('ws');
const AWS = require('aws-sdk');
const axios = require('axios').default;
const lineByLine = require('n-readlines');
const Promise = require('bluebird');

require('dotenv').config()

// we need to set a region even if we don't make any calls
AWS.config.update({region:'us-east-1'});

const FULLNODE_URL = process.env.FULLNODE_URL || 'ws://localhost:8080/v1a/ws/';
const eventTemplate = fs.readFileSync('events/eventTemplate.json', 'utf8');

const DEFAULT_SERVER = process.env.DEFAULT_SERVER || 'https://node1.foxtrot.testnet.hathor.network/v1a/';
const globalCache = {};

const main = async () => {
  const response = await axios.get(DEFAULT_SERVER + 'transaction?type=block&count=1');

  const { transactions } = response.data;
  const bestBlock = transactions[0];
  const bestBlockHeight = bestBlock.height;
  const parents = bestBlock.parents;

  await downloadBlocks(bestBlock.tx_id, 3000);

  return;
};

const downloadBlocks = async (fromTxId, toHeight) => {
  const handle = fs.createWriteStream('./blocks.txt');

  const blocks = await recursivelyDownloadBlocks(handle, fromTxId, toHeight);

  handle.end();
};

const downloadTxFromBlocks = async (quantity) => {
  const liner = new lineByLine('./blocks.txt');

  let line;
  while (line = liner.next()) {
    const [blockId, tx1, tx2] = line.toString().split(' ');

    const data = await recursivelyDownloadTx(blockId, [tx1, tx2]);
    if (data.length > 0) {
      console.log(data.length);
      for (let i = 0; i < data.length; i++) {
        const prepared = prepareTx(data[i]);

        await new Promise((resolve) => {
          sendEvent(prepared);

          setTimeout(resolve, 300);
        });

        console.log('Sent tx: ', prepared.tx_id);
      }
    }
  }
};

const downloadTx = async (txId) => {
  const response = await axios.get(DEFAULT_SERVER + `transaction?id=${txId}`);

  if (globalCache[txId]) return globalCache[txId];

  globalCache[txId] = response.data;

  return response.data;
};

// We need to fetch
const recursivelyDownloadTx = async (blockId, txIds = [], data = []) => {
  if (txIds.length === 0) {
    return data;
  }

  const txId = txIds.pop(); // Mutate txIds
  const txData = await downloadTx(txId);
  const { tx, meta } = txData;

  if (tx.parents.length > 2) {
    // We downloaded a block, we should ignore it
    return recursivelyDownloadTx(blockId, txIds, data);
  }

  if (meta.first_block !== blockId) {
    return recursivelyDownloadTx(blockId, txIds, data);
  }

  const newParents = tx.parents.filter((parent) => {
    return txIds.indexOf(parent) < 0;
  });

  return recursivelyDownloadTx(blockId, [...txIds, ...newParents], [...data, tx]);
};

const recursivelyDownloadBlocks = async (handle, txId, targetHeight, data = []) => {
  const txData = await downloadTx(txId);
  const { tx, meta } = txData;

  console.log(meta.height);

  handle.write(`${txId} ${tx.parents[1]} ${tx.parents[2]}\r\n`);

  const prepared = prepareTx(tx);

  await sendEvent(prepared);

  if (meta.height === targetHeight) {
    return txId;
  }

  const nextBlock = tx.parents[0];

  return recursivelyDownloadBlocks(handle, nextBlock, targetHeight, [] /*[...data, tx]*/);
};

const prepareTx = (tx) => {
  return {
    ...tx,
    tx_id: tx.hash,
    raw: '',
    outputs: tx.outputs.map((output) => {
      if (!output.token) {
        output.token = '00';
      }

      return output;
    }),
  }
};

// --

const lambda = new AWS.Lambda({
  apiVersion: '2015-03-31',
  endpoint: process.env.LAMBDA_ENDPOINT || 'http://localhost:3002',
});

const sendEvent = async (msg) => {
  return new Promise((resolve, reject) => {
    const newEvent = JSON.parse(eventTemplate);
    const record = newEvent.Records[0];
    record.body = msg;
    record.messageId = msg.tx_id;
    record.md5OfBody = msg.tx_id;
    record.attributes.MessageDeduplicationId = msg.tx_id;

    const params = {
      // FunctionName is composed of: service name - stage - function name
      FunctionName: 'hathor-wallet-service-production-onNewTxEvent',
      // we could just send the tx, but we'll use the template to emulate a SQS message
      Payload: JSON.stringify(newEvent),
    };
    lambda.invoke(params, (err, data) => {
      console.log('data: ', data);
      if (err) {
        console.error('ERROR', msg.tx_id, err);
        reject();
        return process.exit(1);
      } else {
        resolve()
        console.log('lambda successfull for', msg.tx_id);
        // queue.shift();
        /*if (queue.length > 0) {
          const tx = queue[0];
          console.log('process from queue', tx.tx_id, 'height', tx.height);
          sendEvent(tx);
        }*/
      }
    });
  });
};

module.exports = {
  main,
  downloadBlocks,
  downloadTxFromBlocks,
};
