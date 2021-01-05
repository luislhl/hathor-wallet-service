import { APIGatewayProxyHandler } from 'aws-lambda';
import { ServerlessMysql } from 'serverless-mysql';
import 'source-map-support/register';
import { v4 as uuidv4 } from 'uuid';

import { ApiError } from '@src/api/errors';
import { getWalletBalances } from '@src/commons';
import {
  addTxProposalOutputs,
  createTxProposal,
  getUnusedAddresses,
  getUtxos,
  getWallet,
  getWalletSortedValueUtxos,
  markUtxosWithProposalId,
} from '@src/db';
import { Balance, IWalletInput, IWalletOutput, TokenBalanceMap, Utxo, WalletTokenBalance } from '@src/types';
import { arrayShuffle, closeDbConnection, getDbConnection, getUnixTimestamp } from '@src/utils';
import hathorLib from '@hathor/wallet-lib';

const mysql = getDbConnection();

enum InputSelectionAlgo {
  USE_LARGER_UTXOS = 'use-larger-utxos',
}

interface IWalletInsufficientFunds {
  tokenId: string;
  requested: number;
  available: number;
}

/*
 * Create a tx-proposal.
 *
 * This lambda is called by API Gateway on POST /txproposals
 */
export const create: APIGatewayProxyHandler = async (event) => {
  let body;
  try {
    body = JSON.parse(event.body);
    // event.body might be null, which is also parsed to null
    if (!body) throw new Error('body is null');
  } catch (e) {
    await closeDbConnection(mysql);
    return {
      statusCode: 200,
      body: JSON.stringify({ success: false, error: ApiError.INVALID_PAYLOAD }),
    };
  }

  const walletId = body.id;
  if (!walletId) {
    await closeDbConnection(mysql);
    return {
      statusCode: 200,
      body: JSON.stringify({ success: false, error: ApiError.MISSING_PARAMETER, parameter: 'id' }),
    };
  }

  const rawOutputs = body.outputs;
  if (!rawOutputs) {
    await closeDbConnection(mysql);
    return {
      statusCode: 200,
      body: JSON.stringify({ success: false, error: ApiError.MISSING_PARAMETER, parameter: 'outputs' }),
    };
  }

  // TODO get limit from the full-node (https://github.com/HathorNetwork/hathor-wallet-service/issues/12)
  if (rawOutputs.length > 255) {
    await closeDbConnection(mysql);
    return {
      statusCode: 200,
      body: JSON.stringify({ success: false, error: ApiError.TOO_MANY_OUTPUTS, outputs: rawOutputs.length }),
    };
  }

  const outputs = parseValidateOutputs(rawOutputs);
  if (!outputs || outputs.length === 0) {
    await closeDbConnection(mysql);
    return {
      statusCode: 200,
      body: JSON.stringify({ success: false, error: ApiError.INVALID_PARAMETER, parameter: 'outputs' }),
    };
  }

  const rawInputs = body.inputs;
  let inputs = null;
  if (rawInputs) {
    inputs = parseValidateInputs(rawInputs);
    if (!inputs) {
      await closeDbConnection(mysql);
      return {
        statusCode: 200,
        body: JSON.stringify({ success: false, error: ApiError.INVALID_PARAMETER, parameter: 'inputs' }),
      };
    }
  }

  const inputSelectionAlgo = (function getInputAlgoFromBody() {
    if (!body.inputSelectionAlgo) return InputSelectionAlgo.USE_LARGER_UTXOS;

    return InputSelectionAlgo[body.inputSelectionAlgo];
  }());

  if (!inputSelectionAlgo) {
    await closeDbConnection(mysql);

    return {
      statusCode: 200,
      body: JSON.stringify({ success: false, error: ApiError.INVALID_SELECTION_ALGO }),
    };
  }

  const status = await getWallet(mysql, walletId);
  if (!status) {
    await closeDbConnection(mysql);
    return {
      statusCode: 200,
      body: JSON.stringify({ success: false, error: ApiError.WALLET_NOT_FOUND }),
    };
  }

  if (!status.readyAt) {
    await closeDbConnection(mysql);

    return {
      statusCode: 200,
      body: JSON.stringify({ success: false, error: ApiError.WALLET_NOT_READY }),
    };
  }

  const now = getUnixTimestamp();
  const outputsBalance = getOutputsBalance(outputs, now);

  // check if wallet's balances are enough for the request
  const balances = await getWalletBalances(mysql, now, walletId, outputsBalance.getTokens());
  const insufficientFunds = checkWalletFunds(balances, outputsBalance);
  if (insufficientFunds.length > 0) {
    await closeDbConnection(mysql);
    return {
      statusCode: 200,
      body: JSON.stringify({ success: false, error: ApiError.INSUFFICIENT_FUNDS, insufficient: insufficientFunds }),
    };
  }

  // fetch the utxos that will be used
  let inputUtxos = [];
  if (inputs) {
    inputUtxos = await getUtxos(mysql, inputs);

    const missing = checkMissingUtxos(inputs, inputUtxos);

    if (missing.length > 0) {
      await closeDbConnection(mysql);
      return {
        statusCode: 200,
        body: JSON.stringify({ success: false, error: ApiError.INPUTS_NOT_FOUND, missing }),
      };
    }
    // check if inputs sent by user are not part of another tx proposal
  } else {
    for (const [tokenId, tokenBalance] of outputsBalance.iterator()) {
      const utxos = await getUtxosForTokenBalance(mysql, inputSelectionAlgo, walletId, tokenId, tokenBalance);
      inputUtxos.push(...utxos);
    }
  }

  // TODO get limit from the full-node (https://github.com/HathorNetwork/hathor-wallet-service/issues/12)
  if (inputUtxos.length > 255) {
    await closeDbConnection(mysql);
    return {
      statusCode: 200,
      body: JSON.stringify({ success: false, error: ApiError.TOO_MANY_INPUTS, inputs: inputUtxos.length }),
    };
  }

  // the difference between inputs and outputs will be the change
  const inputsBalance = getInputsBalance(inputUtxos);
  const diff = TokenBalanceMap.merge(outputsBalance, inputsBalance);

  // Make sure diff is 0 or lower, which means inputs sum is grater than (or equal to) outputs sum.
  // This should only happen when we receive the inputs from user and he didn't select enough inputs.
  const insufficientInputs = [];
  for (const [token, tokenBalance] of diff.iterator()) {
    if (tokenBalance.total() > 0) insufficientInputs.push(token);
  }
  if (insufficientInputs.length > 0) {
    await closeDbConnection(mysql);
    return {
      statusCode: 200,
      body: JSON.stringify({ success: false, error: ApiError.INSUFFICIENT_INPUTS, insufficient: insufficientInputs }),
    };
  }

  const addresses = await getUnusedAddresses(mysql, walletId);
  const changeOutputs = getChangeOutputs(diff, addresses);

  const finalOutputs = outputs.concat(changeOutputs);

  // TODO get limit from the full-node (https://github.com/HathorNetwork/hathor-wallet-service/issues/12)
  if (finalOutputs.length > 255) {
    // we also need to do this check here, as we may have added change outputs
    await closeDbConnection(mysql);
    return {
      statusCode: 200,
      body: JSON.stringify({ success: false, error: ApiError.TOO_MANY_OUTPUTS, outputs: finalOutputs.length }),
    };
  }

  // shuffle array
  arrayShuffle(finalOutputs);

  // mark utxos with tx-proposal id
  // XXX should this be done atomically?
  const txProposalId = uuidv4();
  markUtxosWithProposalId(mysql, txProposalId, inputUtxos);

  await createTxProposal(mysql, txProposalId, walletId, now);
  await addTxProposalOutputs(mysql, txProposalId, finalOutputs);

  await closeDbConnection(mysql);

  return {
    statusCode: 200,
    body: JSON.stringify({
      success: true,
      txProposalId,
      inputs: inputUtxos.map((utxo) => ({ txId: utxo.txId, index: utxo.index })),
      outputs: finalOutputs,
    }),
  };
};

/**
 * Validate that received outputs have the correct types and transform to IWalletOutput interface.
 *
 * @param outputs - The received outputs
 * @returns The parsed outputs, or null if there's been an error
 */
export const parseValidateOutputs = (outputs: unknown[]): IWalletOutput[] => {
  const parsedOutputs = [];
  for (const output of outputs) {
    const parsed = {
      address: output[0],
      value: output[1],
      token: output[2],
      timelock: output[3],
    };

    if (!hathorLib.transaction.isAddressValid(parsed.address)) {
      // invalid address
      return null;
    }

    if (typeof parsed.address !== 'string' || typeof parsed.value !== 'number'
      || typeof parsed.token !== 'string' || (parsed.timelock !== null && typeof parsed.timelock !== 'number')) {
      // types are not correct
      return null;
    }
    parsedOutputs.push(parsed);
  }
  return parsedOutputs;
};

/**
 * Validate that received inputs have the correct types and transform to WalletInput interface.
 *
 * @param inputs - The received inputs
 * @returns The parsed inputs, or null if there's been an error
 */
export const parseValidateInputs = (inputs: unknown[]): IWalletInput[] => {
  const parsedInputs = [];
  for (const input of inputs) {
    const parsed = {
      txId: input[0],
      index: input[1],
    };
    if (typeof parsed.txId !== 'string' || typeof parsed.index !== 'number') {
      // types are not correct
      return null;
    }
    parsedInputs.push(parsed);
  }
  return parsedInputs;
};

/**
 * Calculates the total balance for the outputs.
 *
 * @param outputs - List of outputs
 * @param now - Current timestamp
 * @returns A balance map merging all outputs
 */
export const getOutputsBalance = (outputs: IWalletOutput[], now: number): TokenBalanceMap => {
  let outputsBalance = null;
  for (const output of outputs) {
    const decoded = { type: 'P2PKH', address: output.address, timelock: output.timelock };
    // take advantage of TokenBalanceMap.fromTxOuput
    const txOutput = {
      decoded,
      value: output.value,
      token: output.token,
      // TODO not handling authority outputs
      token_data: 0,
      script: null,
      spent_by: null,
      locked: output.timelock > now,
    };
    outputsBalance = TokenBalanceMap.merge(outputsBalance, TokenBalanceMap.fromTxOutput(txOutput));
  }
  return outputsBalance;
};

/**
 * Calculates the total balance for the input UTXOs.
 *
 * @param inputUtxos - List of input UTXOs
 * @returns A balance map merging all input UTXOs
 */
export const getInputsBalance = (inputUtxos: Utxo[]): TokenBalanceMap => {
  let inputsBalance = null;
  for (const utxo of inputUtxos) {
    const decoded = { type: 'P2PKH', address: utxo.address, timelock: utxo.timelock };
    // take advantage of TokenBalanceMap.fromTxInput
    const txInput = {
      decoded,
      tx_id: utxo.txId,
      index: utxo.index,
      value: utxo.value,
      token: utxo.tokenId,
      // TODO not handling authorities
      token_data: 0,
      script: null,
    };
    inputsBalance = TokenBalanceMap.merge(inputsBalance, TokenBalanceMap.fromTxInput(txInput));
  }
  return inputsBalance;
};

/**
 * Create the change outputs, given the difference between inputs and outputs.
 *
 * @remarks
 * Balances should either be zero or negative. A positive balance would indicate that the sum of
 * outputs is greater than the inputs, which would make an invalid transaction.
 *
 * @param diff - The difference between outputs and inputs
 * @returns The change outputs
 */
export const getChangeOutputs = (diff: TokenBalanceMap, addresses: string[]): IWalletOutput[] => {
  const changeOutputs = [];
  let addressToUse = 0;
  for (const [token, balance] of diff.iterator()) {
    if (balance.total() < 0) {
      changeOutputs.push({
        address: addresses[addressToUse++],
        value: Math.abs(balance.total()),
        token,
        timelock: null,
      });

      if (addressToUse >= addresses.length) {
        // this treats an unlikely case, where we have more change outputs than addresses. In this case,
        // we will repeat some addresses. Ideally, we should just generate more, but it's so unlikely
        // that this happens that we can handle it later
        addressToUse = 0;
      }
    }
  }
  return changeOutputs;
};

/**
 * Select the UTXOs to be spent, given the token balance.
 *
 * @param _mysql - The database connection
 * @param inputSelectionAlgo - The input selection algorithm
 * @param walletId - The wallet id
 * @param tokenId - The token id
 * @param tokenBalance - Balance for the queried token
 * @returns A list of UTXOs that sum at least the requested balance
 */
const getUtxosForTokenBalance = async (
  _mysql: ServerlessMysql,
  inputSelectionAlgo: InputSelectionAlgo,
  walletId: string,
  tokenId: string,
  tokenBalance: Balance,
): Promise<Utxo[]> => {
  switch (inputSelectionAlgo) {
    case InputSelectionAlgo.USE_LARGER_UTXOS:
    default:
      return useLargerUtxos(_mysql, walletId, tokenId, tokenBalance.total());
  }
};

export const useLargerUtxos = async (
  _mysql: ServerlessMysql,
  walletId: string,
  tokenId: string,
  balance: number,
): Promise<Utxo[]> => {
  const finalUtxos: Utxo[] = [];

  let remainingBalance = balance;
  const valueUtxos = await getWalletSortedValueUtxos(_mysql, walletId, tokenId);
  for (const utxo of valueUtxos) {
    remainingBalance -= utxo.value;
    finalUtxos.push(utxo);
    if (remainingBalance <= 0) break;
  }

  return finalUtxos;
};

/**
 * Check if the wallet has the required amount for each token.
 *
 * @remarks
 * The check is only done using the wallet's unlocked tokens.
 *
 * @param walletBalances - The wallet's balance for all requested tokens
 * @param outputsBalance - The amount requested for each token
 * @returns A list of tokens whose requested value is larger than the wallet's available balance
 */
export const checkWalletFunds = (walletBalances: WalletTokenBalance[], outputsBalance: TokenBalanceMap): IWalletInsufficientFunds[] => {
  const insufficientFunds = [];
  const missingTokens = new Set(outputsBalance.getTokens());
  for (const balance of walletBalances) {
    const token = balance.token;
    missingTokens.delete(token.id);
    const requested = outputsBalance.get(token.id).total();
    const available = balance.balance.unlockedAmount;
    if (requested > available) {
      // unlocked tokens are not enough
      insufficientFunds.push({ tokenId: token.id, requested, available });
    }
  }
  for (const tokenId of missingTokens) {
    // these tokens don't have any balance in the wallet
    insufficientFunds.push({ tokenId, requested: outputsBalance.get(tokenId).total(), available: 0 });
  }
  return insufficientFunds;
};

/**
 * Confirm that all inputs requested by the user have been fetched.
 *
 * @param inputs - List of inputs sent by the user
 * @param utxos - List of UTXOs retrieved from database
 * @returns A list with the missing UTXOs, if any
 */
export const checkMissingUtxos = (inputs: IWalletInput[], utxos: Utxo[]): IWalletInput[] => {
  if (inputs.length === utxos.length) return [];

  const remaining = new Set(inputs.map((input) => [input.txId, input.index]));
  for (const utxo of utxos) {
    remaining.delete([utxo.txId, utxo.index]);
  }

  const missing = [];
  for (const utxo of remaining) {
    missing.push({ txId: utxo[0], index: utxo[1] });
  }
  return missing;
};
