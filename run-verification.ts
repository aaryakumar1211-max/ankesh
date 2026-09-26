import { PricingCascadePipeline, MarginFloorValidator, VolumeRebateLedger } from './packages/pricing-engine/src/index.ts';
import { FreightDensityEngine, LandedCostCalculator } from './packages/logistics-engine/src/index.ts';
import { StreamingBomParser, FffObsolescenceEngine, CadMetadataExtractor } from './packages/engineering-tools/src/index.ts';
import { ParametricIndexer, FacetQueryBuilder } from './packages/search/src/index.ts';
import { RfqStateMachine, QuoteTokenValidator, PunchOutHandler } from './packages/procurement-engine/src/index.ts';
import { X12Generator, X12Parser, RedlockManager } from './packages/edi-engine/src/index.ts';
import { FieldEncryption, PiiRedactor, AbacPolicyEvaluator } from './packages/security-engine/src/index.ts';
import { HashChainLedger, AntiTamperValidator } from './packages/audit-engine/src/index.ts';
import { TreeResolver, ScopedRbacEvaluator, SpendingStateMachine } from './packages/governance-engine/src/index.ts';
import { createEnterpriseApiContext } from './apps/api/src/index.ts';
import { IncotermRule, PolicyEffect, AuditSeverity, CartStatus, StandardRole, ScopeType } from './packages/database/src/index.ts';

console.log('================================================================');
console.log('       ENTERPRISE PLATFORM COMPREHENSIVE RUNTIME AUDIT          ');
console.log('================================================================\n');

let totalTests = 0;
let passedTests = 0;

function assert(condition: boolean, testName: string, details?: string) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  [PASS] ${testName}${details ? ` -> ${details}` : ''}`);
  } else {
    console.error(`  [FAIL] ${testName}${details ? ` -> ${details}` : ''}`);
    throw new Error(`Assertion failed for test: ${testName}`);
  }
}

// 1. PRICING ENGINE
console.log('1. Testing Pricing Engine...');
const pipeline = new PricingCascadePipeline();
pipeline.registerContractPrice({
  priceBookId: 'pb-tesla',
  priceBookType: 'CUSTOMER_CONTRACT',
  organizationId: 'org-tesla',
  partNumber: 'LM358DR',
  unitPrice: 0.12,
});
pipeline.registerQuantityBreaks('LM358DR', [
  { partNumber: 'LM358DR', minQuantity: 100, maxQuantity: 499, discountPercent: 8 },
  { partNumber: 'LM358DR', minQuantity: 500, discountPercent: 15 },
]);

// Contract price test
const teslaPrice = pipeline.resolvePrice({
  partNumber: 'LM358DR',
  quantity: 500,
  organizationId: 'org-tesla',
  baseMsrp: 0.25,
});
assert(teslaPrice.resolvedUnitPrice === 0.12, 'Contract price resolution', `$${teslaPrice.resolvedUnitPrice}`);

// Volume break test
const openMarketPrice = pipeline.resolvePrice({
  partNumber: 'LM358DR',
  quantity: 500,
  baseMsrp: 0.25,
});
assert(openMarketPrice.resolvedUnitPrice === 0.2125, 'Volume break resolution', `$${openMarketPrice.resolvedUnitPrice} (15% off)`);

// Margin floor validator
const marginValidator = new MarginFloorValidator(18.0, 22.0);
const rejectedMargin = marginValidator.evaluate({
  partNumber: 'LM358DR',
  unitSellingPrice: 0.10,
  unitCostPrice: 0.09, // 10% margin < 18% floor
  quantity: 100,
});
assert(!rejectedMargin.isApproved, 'Margin floor rejection below 18%', `Margin: ${rejectedMargin.grossMarginPercent}%`);

// Volume Rebate Ledger
const rebateLedger = new VolumeRebateLedger();
rebateLedger.recordSpend('org-acme', 550000, 2026);
const rebateState = rebateLedger.getRebateState('org-acme', 2026);
assert(rebateState.currentTier === 'GOLD', 'Volume rebate Gold tier reached', `Accrued credit: $${rebateState.accruedCreditUsd}`);

// 2. LOGISTICS ENGINE
console.log('\n2. Testing Logistics Engine...');
const densityEngine = new FreightDensityEngine();
const densityResult = densityEngine.calculateFreightClass({
  lengthInches: 48,
  widthInches: 40,
  heightInches: 36,
  weightLbs: 2500,
});
assert(densityResult.freightClass === 50, 'NMFC heavy density classification', `Density: ${densityResult.densityPcf} PCF -> Class ${densityResult.freightClass}`);

const landedCostCalc = new LandedCostCalculator();
const landedResult = landedCostCalc.calculate({
  fobPriceUsd: 10.0,
  quantity: 1000,
  internationalFreightUsd: 1200,
  tariffRatePct: 3.5,
  insuranceRatePct: 0.5,
  customsBrokerageFeeUsd: 150,
  lastMileDeliveryUsd: 250,
  incoterm: IncotermRule.FOB,
});
assert(landedResult.totalLandedCostUsd === 12043.75, 'Landed cost calculation with duties', `$${landedResult.totalLandedCostUsd}`);

// 3. ENGINEERING TOOLS & BOM
console.log('\n3. Testing Engineering Tools & BOM Parser...');
const sampleBom = `Part Number,Manufacturer,Ref Des,Quantity,Package
LM358D,STMicroelectronics,"U1, U2",2,SOIC-8
RC0603FR-0710KL,YAGEO,"R1, R2",2,0603
`;
const bomParser = new StreamingBomParser();
const parseResult = bomParser.parse(sampleBom, 'test.csv');
assert(parseResult.validItems.length === 2, 'Streaming BOM parser', `${parseResult.validItems.length} items parsed`);

const fffEngine = new FffObsolescenceEngine([
  {
    mpn: 'LM358DR',
    manufacturer: 'Texas Instruments',
    category: 'Integrated Circuits (ICs)',
    package: 'SOIC-8',
    mountingType: 'Surface Mount',
    pinCount: 8,
    lifecycleStatus: 'ACTIVE',
    rohsCompliant: true,
    stockQuantity: 450000,
    unitPriceUsd: 0.18,
  },
]);
const replacements = fffEngine.findReplacements({
  mpn: 'LM358D',
  manufacturer: 'STMicroelectronics',
  category: 'Integrated Circuits (ICs)',
  package: 'SOIC-8',
  mountingType: 'Surface Mount',
  pinCount: 8,
  lifecycleStatus: 'OBSOLETE',
  rohsCompliant: false,
  stockQuantity: 0,
  unitPriceUsd: 0.50,
});
assert(replacements.length > 0 && replacements[0].replacementPart.mpn === 'LM358DR', 'FFF drop-in replacement detection', `Top match: ${replacements[0]?.replacementPart.mpn}`);

const cadExtractor = new CadMetadataExtractor();
const cadResult = cadExtractor.inspectAssembly('test_assembly.step');
assert(cadResult.components.length > 0, 'CAD assembly inspection & vector decomposition', `${cadResult.components.length} components`);

// 4. PARAMETRIC SEARCH ENGINE
console.log('\n4. Testing Search Engine...');
const sampleCatalog = [
  {
    id: 'c1',
    mpn: 'RC0603FR-0710KL',
    manufacturer: 'YAGEO',
    category: 'Resistors',
    package: '0603',
    mountingType: 'Surface Mount',
    lifecycleStatus: 'ACTIVE',
    rohsCompliant: true,
    stockQuantity: 50000,
    unitPriceUsd: 0.008,
  },
  {
    id: 'c2',
    mpn: 'LM358DR',
    manufacturer: 'Texas Instruments',
    category: 'Integrated Circuits (ICs)',
    package: 'SOIC-8',
    mountingType: 'Surface Mount',
    lifecycleStatus: 'ACTIVE',
    rohsCompliant: true,
    stockQuantity: 100000,
    unitPriceUsd: 0.18,
  },
];
const searchIndexer = new ParametricIndexer(sampleCatalog);
const searchRes = searchIndexer.search({
  q: 'LM358',
  page: 1,
  perPage: 10,
});
assert(searchRes.hits.length === 1 && searchRes.hits[0].mpn === 'LM358DR', 'Parametric search indexing', `Found: ${searchRes.hits[0]?.mpn}`);

// 5. PROCUREMENT ENGINE
console.log('\n5. Testing Procurement Engine...');
const rfqMachine = new RfqStateMachine();
const createdRfq = rfqMachine.createRfq({
  title: 'Sensors Order',
  partNumber: 'BME280',
  targetQuantity: 5000,
  validUntil: new Date(Date.now() + 86400000),
  requesterId: 'u1',
  costCenterId: 'cc1',
});
rfqMachine.openForBids(createdRfq.id);
const withBid = rfqMachine.submitBid(createdRfq.id, {
  supplierName: 'Bosch Dist',
  bidUnitPrice: 2.10,
  leadTimeDays: 7,
});
const awardedRfq = rfqMachine.awardBid(createdRfq.id, withBid.bids[0].id);
assert(awardedRfq.status === 'AWARDED', 'RFQ complete award state transition', `Status: ${awardedRfq.status}`);

const tokenValidator = new QuoteTokenValidator('sec-key-12345678901234567890123456789012');
const quotePayload = {
  id: 'q1',
  supplierId: 's1',
  partNumber: 'BME280',
  lockedUnitPrice: 2.10,
  currency: 'USD',
  quantityTier: 5000,
  leadTimeDays: 7,
  expiresAt: new Date(Date.now() + 86400000),
};
const { tokenHash, signature } = tokenValidator.signQuote(quotePayload);
const valResult = tokenValidator.validateQuote(quotePayload, tokenHash, signature);
assert(valResult.isValid, 'HMAC-SHA256 QuoteToken verification', `Valid: ${valResult.isValid}`);

const punchOut = new PunchOutHandler();
const cxmlSetup = punchOut.generateSetupResponse('https://app.corp/punchout', 'cookie-123');
assert(cxmlSetup.includes('<PunchOutSetupResponse>'), 'cXML PunchOut response generation');

// 6. EDI ENGINE
console.log('\n6. Testing EDI Engine...');
const x12Gen = new X12Generator('*', '~');
const x12Parser = new X12Parser('*', '~');
const generated850 = x12Gen.generate850({
  senderId: 'BUYER',
  receiverId: 'SELLER',
  poNumber: 'PO-8812',
  poDate: '2026-08-18',
  lines: [{ lineIndex: 1, quantity: 100, uom: 'EA', unitPrice: 1.5, partNumber: 'PART-A' }],
});
const parsed850 = x12Parser.parse(generated850);
assert(parsed850.length === 1 && parsed850[0].header.poNumber === 'PO-8812', 'ANSI X12 850 generation & parsing round-trip', `PO: ${parsed850[0]?.header.poNumber}`);

const lockManager = new RedlockManager();
const acquiredLock = await lockManager.acquireLock('edi:lock:test', 5000);
const secondAttempt = await lockManager.acquireLock('edi:lock:test', 5000);
assert(acquiredLock !== null && secondAttempt === null, 'Redlock distributed mutex exclusion', `Concurrent blocked: ${secondAttempt === null}`);
await lockManager.releaseLock(acquiredLock!);

// 7. SECURITY & CRYPTO ENGINE
console.log('\n7. Testing Security & Crypto Engine...');
const fieldCrypto = new FieldEncryption('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'k1');
const secretText = 'CONFIDENTIAL_DATA_998877';
const encrypted = fieldCrypto.encrypt(secretText);
const decrypted = fieldCrypto.decrypt(encrypted);
assert(decrypted === secretText, 'AES-256-GCM authenticated field encryption', `Decrypted verified`);

const redacted = PiiRedactor.redactString('SSN: 123-45-6789 Card: 4111-2222-3333-4444');
assert(redacted.includes('***-**-6789') && redacted.includes('****-****-****-4444'), 'PII and secret redaction');

const abac = new AbacPolicyEvaluator([
  {
    id: 'r1',
    name: 'MFA spend rule',
    effect: PolicyEffect.ALLOW,
    actionPattern: 'spend:approve',
    resourceType: 'spend_cart',
    requireMfa: true,
    priority: 100,
  },
]);
const abacDenied = abac.evaluate({ id: 'u1', roles: [], mfaActive: false }, 'spend:approve', { type: 'spend_cart', id: 'c1' });
const abacAllowed = abac.evaluate({ id: 'u1', roles: [], mfaActive: true }, 'spend:approve', { type: 'spend_cart', id: 'c1' });
assert(!abacDenied.allowed && abacAllowed.allowed, 'ABAC dynamic policy evaluation with MFA');

// 8. AUDIT ENGINE (HASH CHAINING)
console.log('\n8. Testing Audit Hash Chain Engine...');
const hashLedger = new HashChainLedger('hmac-ledger-secret-32b-length!!!', fieldCrypto);
const antiTamper = new AntiTamperValidator(hashLedger);
for (let i = 1; i <= 20; i++) {
  hashLedger.appendEvent({
    actorId: `user-${i}`,
    action: 'cart.submit',
    resource: `cart-${i}`,
    payload: { amount: 100 * i },
    severity: AuditSeverity.INFO,
  });
}
const auditEntries = hashLedger.getEntries();
const initialVerify = antiTamper.verifyChain(auditEntries);
assert(initialVerify.isValid && initialVerify.totalEntriesVerified === 20, 'HMAC-SHA256 hash-chain 20-event sequence integrity');

// Tamper test
const tamperedEntries = JSON.parse(JSON.stringify(auditEntries));
tamperedEntries[5].action = 'cart.tampered';
const tamperVerify = antiTamper.verifyChain(tamperedEntries);
assert(!tamperVerify.isValid && tamperVerify.tamperIndex === 5, 'Anti-tamper cryptographic detection', `Caught tamper at index ${tamperVerify.tamperIndex}`);

// 9. GOVERNANCE ENGINE
console.log('\n9. Testing Governance Engine...');
const orgs = [{ id: 'o1', name: 'Global', slug: 'global', parentId: null }];
const costCenters = [{ id: 'cc1', code: 'CC1', name: 'Eng', organizationId: 'o1', managerId: 'u2', monthlyBudget: 50000, currency: 'USD' }];
const users = [
  { id: 'u1', email: 'dev@corp.com', name: 'Dev', organizationId: 'o1', costCenterId: 'cc1', managerId: 'u2', status: 'ACTIVE' },
  { id: 'u2', email: 'lead@corp.com', name: 'Lead', organizationId: 'o1', costCenterId: 'cc1', managerId: null, status: 'ACTIVE' },
];
const grants = [
  { userId: 'u1', roleName: StandardRole.EMPLOYEE, scopeType: ScopeType.COST_CENTER, costCenterId: 'cc1', permissions: ['spend:create'] },
  { userId: 'u2', roleName: StandardRole.DEPARTMENT_HEAD, scopeType: ScopeType.COST_CENTER, costCenterId: 'cc1', permissions: ['spend:approve'] },
];
const tree = new TreeResolver(orgs, costCenters, users);
const rbac = new ScopedRbacEvaluator(tree, grants);
const spending = new SpendingStateMachine(tree, rbac);

const autoCart = spending.submitCart({ id: 'cart-small', title: 'Mouse', amount: 450, currency: 'USD', requesterId: 'u1', costCenterId: 'cc1' });
assert(autoCart.status === CartStatus.AUTO_APPROVED, 'Tier 1 Auto-approval under $5k', `Status: ${autoCart.status}`);

const deptCart = spending.submitCart({ id: 'cart-mid', title: 'Workstation', amount: 8500, currency: 'USD', requesterId: 'u1', costCenterId: 'cc1' });
assert(deptCart.status === CartStatus.PENDING_DEPARTMENT_HEAD, 'Tier 2 Department Head approval requirement', `Status: ${deptCart.status}`);

// 10. API INTEGRATION CONTEXT
console.log('\n10. Testing Backend API Context Initialization...');
const apiContext = createEnterpriseApiContext();
assert(apiContext.healthController !== undefined, 'API Server Context creation');
assert(apiContext.pricingController !== undefined, 'Pricing Controller integrated in API Context');
assert(apiContext.rfqController !== undefined, 'RFQ Controller integrated in API Context');
assert(apiContext.ediWebhookController !== undefined, 'EDI Webhook Controller integrated in API Context');

console.log('\n================================================================');
console.log(` AUDIT SUMMARY: ${passedTests} / ${totalTests} TESTS PASSED (100% SUCCESS)`);
console.log('================================================================\n');
