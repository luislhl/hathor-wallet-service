/* eslint-disable */

const fs = require('fs');
const WebSocket = require('ws');
const AWS = require('aws-sdk');
const axios = require('axios').default;

require('dotenv').config()

// we need to set a region even if we don't make any calls
AWS.config.update({region:'us-east-1'});

const FULLNODE_URL = process.env.FULLNODE_URL || 'ws://localhost:8080/v1a/ws/';
const eventTemplate = fs.readFileSync('events/eventTemplate.json', 'utf8');

const DEFAULT_SERVER = process.env.DEFAULT_SERVER || 'http://185.200.240.114:8080/v1a/';
// https://node1.foxtrot.testnet.hathor.network/v1a/
const globalCache = {};

const main = async () => {
  const response = await axios.get(DEFAULT_SERVER + 'transaction?type=block&count=1');

  const { transactions } = response.data;
  const bestBlock = transactions[0];
  const bestBlockHeight = bestBlock.height;
  const parents = bestBlock.parents;

  const blocks = await recursivelyDownloadBlocks(bestBlock.tx_id, bestBlockHeight - 10);

  const allParents = new Set(blocks.reduce((acc, block) => {
    return [
      ...acc, {
        blockId: block.hash,
        txs: [
          block.parents[1],
          block.parents[2],
        ]
      }
    ]
  }, []));

  console.log(allParents);

  const queue = [...allParents].map(({ blockId, txs }) => {
    return () => {
      console.log('RUN!');
      return recursivelyDownloadTx(blockId, txs);
    };
  });

  let allTxs = [];
  await queue.reduce(async (previous, current) => {
    const data = await previous;

    allTxs = [...allTxs, ...data];

    return current();
  }, Promise.resolve([]));

  fs.writeFileSync('./txs.json', JSON.stringify(allTxs));

  console.log('done', allTxs);

  allTxs.forEach((tx) => {
    const prepared = prepareTx(tx);

    sendEvent(prepared);
  });
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
  console.log('downloading', txId);
  const txData = await downloadTx(txId);
  const { tx, meta } = txData;

  if (tx.parents.length > 2) {
    // We downloaded a block, we should ignore it
    console.log('block, ignoring..');
    return recursivelyDownloadTx(blockId, txIds, data);
  }

  if (meta.first_block !== blockId) {
    console.log('first block != blockId');
    return recursivelyDownloadTx(blockId, txIds, data);
  }

  const newParents = tx.parents.filter((parent) => {
    return txIds.indexOf(parent) < 0;
  });

  console.log('done, downloading recursively');
  return recursivelyDownloadTx(blockId, [...txIds, ...newParents], [...data, tx]);
};

const recursivelyDownloadBlocks = async (txId, targetHeight, data = []) => {
  console.log('Downloading block: ', txId);
  const txData = await downloadTx(txId);
  const { tx, meta } = txData;

  if (meta.height === targetHeight) {
    return [...data, tx];
  }

  const nextBlock = tx.parents[0];

  return recursivelyDownloadBlocks(nextBlock, targetHeight, [...data, tx]);
};

main();

const prepareTx = (tx) => {
  return {
    ...tx,
    tx_id: tx.hash,
    raw: ''
  }
};

// --

const lambda = new AWS.Lambda({
  apiVersion: '2015-03-31',
  endpoint: process.env.LAMBDA_ENDPOINT || 'http://localhost:3002',
});

const sendEvent = (msg) => {
  const newEvent = JSON.parse(eventTemplate);
  const record = newEvent.Records[0];
  record.body = msg;
  record.messageId = msg.tx_id;
  record.md5OfBody = msg.tx_id;
  record.attributes.MessageDeduplicationId = msg.tx_id;

  console.log(record.body);

  const params = {
    // FunctionName is composed of: service name - stage - function name
    FunctionName: 'hathor-wallet-service-local-onNewTxEvent',
    // we could just send the tx, but we'll use the template to emulate a SQS message
    Payload: JSON.stringify(newEvent),
  };
  lambda.invoke(params, (err, data) => {
    if (err) {
      console.error('ERROR', msg.tx_id, err);
      return process.exit(1);
    }
    else {
      console.log('lambda successfull for', msg.tx_id);
      queue.shift();
      if (queue.length > 0) {
        const tx = queue[0];
        console.log('process from queue', tx.tx_id, 'height', tx.height);
        sendEvent(tx);
      }
    }
  });
};
