import { getHathorAddresses, sha256d } from '../utils';
import { addresses, xpubkey } from './utils';


test('getHathorAddresses', () => {
  const calculatedAddresses = getHathorAddresses(xpubkey, 0, addresses.length);
  const addrList = Object.keys(calculatedAddresses);
  expect(addrList.length).toBe(addresses.length);
  expect(addrList).toEqual(addresses);
});

test('sha256d', () => {
  // sha256d(my-test-data) -> 4f1ba9a4204e97a293b16ead6caced38f6d91d95618b96e261c6332ed24f7894
  // sha256d(something-else) -> 5c690b78d489f158d8575e7ed271521d056c445e8bd3978c8295775c1743bec0
  let result = sha256d('my-test-data', 'hex');
  expect(result).toBe('4f1ba9a4204e97a293b16ead6caced38f6d91d95618b96e261c6332ed24f7894');
  result = sha256d('something-else', 'hex');
  expect(result).toBe('5c690b78d489f158d8575e7ed271521d056c445e8bd3978c8295775c1743bec0');
});
