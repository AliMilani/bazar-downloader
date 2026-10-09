import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvalidLinkError, parsePackage } from '../src/link.ts';

const accepted: [string, string][] = [
  ['https://cafebazaar.ir/app/ir.divar', 'ir.divar'],
  ['https://www.cafebazaar.ir/app/ir.divar', 'ir.divar'],
  ['http://cafebazaar.ir/app/ir.divar', 'ir.divar'],
  ['https://cafebazaar.ir/app/ir.divar/', 'ir.divar'],
  ['https://cafebazaar.ir/app/ir.divar?l=en', 'ir.divar'],
  ['https://cafebazaar.ir/app/?id=ir.divar&ref=share', 'ir.divar'],
  ['bazaar://details?id=ir.divar', 'ir.divar'],
  ['ir.divar', 'ir.divar'],
  ['com.Example_app.v2', 'com.Example_app.v2'],
  ['  https://cafebazaar.ir/app/ir.divar\n', 'ir.divar'],
  ['cafebazaar.ir/app/ir.divar', 'ir.divar'],
  ['www.cafebazaar.ir/app/ir.divar?l=fa', 'ir.divar'],
];

for (const [input, expected] of accepted) {
  test(`accepts ${JSON.stringify(input)}`, () => {
    assert.equal(parsePackage(input), expected);
  });
}

const rejected = [
  '',
  'divar',
  'https://example.com/app/ir.divar',
  'https://cafebazaar.ir/',
  'https://cafebazaar.ir/app/',
  'https://cafebazaar.ir/video/ir.divar',
  'https://cafebazaar.ir/app/ir.divar/extra',
  'https://cafebazaar.ir/app/..%2F..%2Fetc',
  'https://cafebazaar.ir/app/?id=../../etc',
  'bazaar://search?id=ir.divar',
  'ftp://cafebazaar.ir/app/ir.divar',
  '../ir.divar',
];

for (const input of rejected) {
  test(`rejects ${JSON.stringify(input)}`, () => {
    assert.throws(() => parsePackage(input), InvalidLinkError);
  });
}
