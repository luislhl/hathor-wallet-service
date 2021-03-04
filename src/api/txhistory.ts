/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { APIGatewayProxyHandler } from 'aws-lambda';
import 'source-map-support/register';
import hathorLib from '@hathor/wallet-lib';

import { ApiError } from '@src/api/errors';
import { closeDbAndGetError } from '@src/api/utils';
import {
  getWallet,
  getWalletTxHistory,
} from '@src/db';
import { closeDbConnection, getDbConnection } from '@src/utils';
import Joi from 'joi';

// XXX add to .env or serverless.yml?
const MAX_COUNT = 15;
const htrToken = hathorLib.constants.HATHOR_TOKEN_CONFIG.uid;

const paramsSchema = Joi.object({
  id: Joi.string()
    .required(),
  token_id: Joi.string()
    .alphanum()
    .default(htrToken)
    .optional(),
  skip: Joi.number()
    .integer()
    .min(0)
    .default(0)
    .optional(),
  count: Joi.number()
    .integer()
    .positive()
    .default(MAX_COUNT)
    .max(MAX_COUNT)
    .optional(),
});

const mysql = getDbConnection();

/*
 * Get the tx-history of a wallet
 *
 * This lambda is called by API Gateway on GET /txhistory
 */
export const get: APIGatewayProxyHandler = async (event) => {
  const params = event.queryStringParameters;

  const { value, error } = paramsSchema.validate(params, {
    abortEarly: false,
    convert: true, // Skip and count will come as query params as strings
  });

  if (error) {
    const details = error.details.map((err) => ({
      message: err.message,
      path: err.path,
    }));

    return closeDbAndGetError(mysql, ApiError.INVALID_PAYLOAD, { details });
  }

  const walletId = value.id;
  const tokenId = value.token_id;
  const skip = value.skip;
  const count = Math.min(MAX_COUNT, value.count);

  const status = await getWallet(mysql, walletId);

  if (!status) {
    return closeDbAndGetError(mysql, ApiError.WALLET_NOT_FOUND);
  }
  if (!status.readyAt) {
    return closeDbAndGetError(mysql, ApiError.WALLET_NOT_READY);
  }

  const history = await getWalletTxHistory(mysql, walletId, tokenId, skip, count);

  await closeDbConnection(mysql);

  return {
    statusCode: 200,
    body: JSON.stringify({ success: true, history, skip, count }),
  };
};
