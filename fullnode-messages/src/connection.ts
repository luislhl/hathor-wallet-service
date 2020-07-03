/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import WebSocket from 'ws';
import { SERVER, AWS_ACCESS_KEY, AWS_SECRET_KEY, AWS_REGION, QUEUE_URL } from './config';
import { EventEmitter } from 'events';
import AWS from 'aws-sdk';

// Setting AWS region
AWS.config.update({ region: AWS_REGION });

const sqs = new AWS.SQS({
  apiVersion: '2012-11-05',
  endpoint: QUEUE_URL,
  accessKeyId: AWS_ACCESS_KEY,
  secretAccessKey: AWS_SECRET_KEY,
});

type wsDataType = { [_: string]: any };

enum FullNodeConnectionState {
  CLOSED,
  CONNECTING,
  READY,
}


class FullNodeConnection extends EventEmitter {
  // Wallet ws state
  state: FullNodeConnectionState = FullNodeConnectionState.CLOSED;
  // Messages to subscribe from full node
  readonly messagesToSubscribe: string[] = ['network:new_tx_accepted'];
  // Subscribed messages to know when the wallet is ready (finished subscribe to all messages)
  subscribedMessages: Set<string> = new Set();
  // Websocket object
  ws: WebSocket | null = null;
  // Heartbeat interval in milliseconds.
  readonly heartbeatInterval: number = 3000;
  // Connection timeout.
  readonly connectionTimeout: number = 5000;
  // Retry connection interval in milliseconds.
  readonly retryConnectionInterval: number = 1000;
  // Open connection timeout.
  readonly openConnectionTimeout: number = 20000;
  // If it's waiting for a pong response
  waitingPongReply: boolean = false;
  // Settimeout reference when waiting for the pong response
  timeoutTimer: NodeJS.Timeout | null = null;
  // Setinterval reference for the ping interval
  heartbeat: NodeJS.Timeout | null = null;

  start(): void {
    if (this.ws !== null) {
      // Was already started
      return;
    }

    this.ws = new WebSocket(SERVER);
    this.setState(FullNodeConnectionState.CONNECTING);

    this.ws.on('error', () => {
      this.onClose();
    });

    this.ws.on('open', () => {
      this.onOpen();
    });

    this.ws.on('close', () => {
      // TODO What should we do when connection is lost? We might have lost some messages
      this.setState(FullNodeConnectionState.CLOSED);
    });

    this.ws.on('message', (message: string) => {
      const data: wsDataType = JSON.parse(message) as wsDataType;
      this.handleMessage(data);
    });
  }

  stop(): void {
    if (this.ws) {
      this.ws.onclose = () => {};
      this.ws.close();
      this.ws = null;
    }
    this.setState(FullNodeConnectionState.CLOSED);
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
      this.waitingPongReply = false;
    }
  }

  private onOpen(): void {
    this.subscribeMessages()
    this.heartbeat = setInterval(() => {
      this.sendPing();
    }, this.heartbeatInterval);
  }

  private onClose(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    setTimeout(() => {
      this.start();
    }, this.retryConnectionInterval);

    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
      this.waitingPongReply = false;
    }
  }

  private sendPing(): void {
    if (this.waitingPongReply) {
      // Skipping sendPing. Still waiting for pong...
      return;
    }

    const msg = JSON.stringify({'type': 'ping'})
    this.waitingPongReply = true;
    this.timeoutTimer = setTimeout(() => this.onClose(), this.connectionTimeout);
    this.sendMessage(msg);
  }

  private onPong(): void {
    this.waitingPongReply = false;

    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  private setState(state: number): void {
    this.state = state;
    this.emit('state', state);
    console.log('State updated to', state);
  }

  private handleMessage(data: wsDataType): void {
    switch(data.type) {
      case 'subscribed':
        this.onSubscribed(data);
        break;
      case 'pong':
        this.onPong();
        break;
      case 'network:new_tx_accepted':
        this.onNewTx(data);
        break;
      default:
        break;
    }
  }

  private onNewTx(data: wsDataType): void {
    const deduplicationId = `new-tx-${data.tx_id as string}`;
    const params = {
      MessageBody: JSON.stringify(data),
      QueueUrl: QUEUE_URL,
      MessageGroupId: 'wallet-service-new-tx',
      MessageDeduplicationId: deduplicationId,
    };

    sqs.sendMessage(params, function(err, data) {
      if (err) console.log(err, err.stack); // an error occurred
      else     console.log(data);           // successful response
    });
  }

  private onSubscribed(data: wsDataType): void {
    if (!data.success) {
      return;
    }

    for (const message of data.messages) {
      if (message in this.messagesToSubscribe) {
        this.subscribedMessages.add(message);
      }
    }

    if (this.subscribedMessages.size === this.messagesToSubscribe.length) {
      // Ready
      this.setState(FullNodeConnectionState.READY);
    }
  }

  private subscribeMessages(): void {
    const msg = JSON.stringify({'type': 'subscribe', 'messages': this.messagesToSubscribe});
    this.sendMessage(msg);
  }

  private sendMessage(message: string): void {
    if (this.ws) {
      // XXX Should we check if ws is ready to send messages?
      this.ws.send(message);
    }
  }
}

export default FullNodeConnection;
