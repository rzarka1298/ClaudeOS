// ccc-presence: OS-mediated owner-presence check for the approval gate
// (APPR-11, D-01 as amended by R-01). Objective-C with ARC, compiled locally
// by scripts/presence/build.sh; no binary is committed.
//
// Subcommands (argv only -- stdin is never read, no environment variable is
// consulted):
//   check                        canEvaluatePolicy and the pin lookup only;
//                                never prompts.
//   prove --message <base64>     validates the message, builds the prompt
//                                text ITSELF from the validated fields, asks
//                                the OS for Touch ID or the password, then
//                                signs the exact message bytes (custody
//                                K-ATTR, below).
//   enrol                        creates the signing key and the pin item.
//   unenrol                      deletes the pin item (and with it the key).
//
// Key custody K-ATTR (09-PRESENCE-SPIKE.md; plan 09-15, R-02): a software
// P-256 key whose private half is the SECRET of one generic-password item
// (service com.claude-command-center, account approval-presence-pin) that
// only this binary is trusted to read. The comment attribute of the same item
// holds the base64 SPKI public key: the PIN a verifier reads attribute-only
// (no secret, no prompt). `prove` signs only after the LocalAuthentication
// check succeeded. A rebuilt binary has a new ad-hoc signature, so it is no
// longer trusted for the old item: install.sh runs `unenrol` with the OLD
// binary, rebuilds, then runs `enrol` with the new one.
//
// Exit codes (closed): 0 ok, 2 usage, 3 unavailable, 4 denied, 5 internal.
// Every outcome prints exactly one JSON line on stdout. Exit 5 prints
// {"v":1,"error":"internal"} and is reached when a validation pattern cannot be
// compiled or when the result line cannot be written to stdout (then nothing
// can be printed and only the exit code carries the failure).
//
// A denial is {"v":1,"result":"denied","error":<LAError code>}. When the 60 s
// ceiling expired instead of the user answering, the same line carries one
// extra closed member: "cause":"timeout" (result stays denied, exit stays 4,
// so every caller that fails closed is unchanged). Absence of "cause" means the
// LAError code is authoritative.
//
// There is no --reason argument and no code path that copies caller text
// into the prompt (T-09-01): the reason string is assembled below from the
// regex-checked proposalId, operation and payloadHash fields only.

#import <Foundation/Foundation.h>
#import <LocalAuthentication/LocalAuthentication.h>
#import <Security/Security.h>

// SecAccess and SecTrustedApplication are the only way to give a legacy
// Keychain item an access list that trusts this binary alone (spike: acl_item).
#pragma clang diagnostic ignored "-Wdeprecated-declarations"

static const int kExitOk = 0;
static const int kExitUsage = 2;
static const int kExitUnavailable = 3;
static const int kExitDenied = 4;
static const int kExitInternal = 5;

// Mirrors PROPOSAL_ID_PATTERN of packages/domain/src/approval.ts.
static NSString *const kProposalIdPattern = @"^[0-9a-z]{25}$";
static NSString *const kOperationPattern = @"^[a-z][a-z0-9.-]{0,63}$";
static NSString *const kPayloadHashPattern = @"^[0-9a-f]{64}$";
static NSString *const kInstantPattern =
    @"^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\\.[0-9]{1,9})?(?:Z|([+-])([0-9]{2}):([0-9]{2}))$";

// The pin item. The account is the one @ccc/keychain reads attribute-only.
static NSString *const kPinService = @"com.claude-command-center";
static NSString *const kPinAccount = @"approval-presence-pin";
static NSString *const kPinLabel = @"Claude Command Center approval presence (safe to delete)";

static const int64_t kProveCeilingSeconds = 60;
static const NSInteger kErrorAppCancel = -9;  // LAErrorAppCancel

// Set when a result line could not be written; the caller then exits 5.
static int emit(int code, NSString *line) {
  if (fputs([[line stringByAppendingString:@"\n"] UTF8String], stdout) == EOF || fflush(stdout) != 0) return kExitInternal;
  return code;
}

static int usage(void) { return emit(kExitUsage, @"{\"v\":1,\"error\":\"usage\"}"); }

static int internalError(void) { return emit(kExitInternal, @"{\"v\":1,\"error\":\"internal\"}"); }

// Returns nil only when the pattern itself cannot be compiled (an internal
// failure, never a property of the caller's input).
static NSRegularExpression *compile(NSString *pattern) {
  return [NSRegularExpression regularExpressionWithPattern:pattern options:0 error:nil];
}

static BOOL fullMatch(NSRegularExpression *re, id value, NSTextCheckingResult *__autoreleasing *out) {
  if (![value isKindOfClass:[NSString class]]) return NO;
  NSRange whole = NSMakeRange(0, [(NSString *)value length]);
  NSTextCheckingResult *m = [re firstMatchInString:value options:0 range:whole];
  if (m == nil || !NSEqualRanges(m.range, whole)) return NO;
  if (out != NULL) *out = m;
  return YES;
}

static NSInteger groupInt(NSString *value, NSTextCheckingResult *m, NSUInteger group) {
  return [[value substringWithRange:[m rangeAtIndex:group]] integerValue];
}

// Strict RFC 3339 instant: real calendar date (leap years honoured), hour
// 0-23, minute 0-59, second 0-59 (no leap second), year >= 1970, and a zone
// offset of at most +/-14:00 with minutes 0-59.
static BOOL isIsoInstant(NSRegularExpression *re, id value) {
  NSTextCheckingResult *m = nil;
  if (!fullMatch(re, value, &m)) return NO;
  NSString *s = value;
  NSInteger year = groupInt(s, m, 1), month = groupInt(s, m, 2), day = groupInt(s, m, 3);
  NSInteger hour = groupInt(s, m, 4), minute = groupInt(s, m, 5), second = groupInt(s, m, 6);
  if (year < 1970 || month < 1 || month > 12 || day < 1) return NO;
  static const int daysIn[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
  BOOL leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
  NSInteger maxDay = daysIn[month - 1] + (month == 2 && leap ? 1 : 0);
  if (day > maxDay) return NO;
  if (hour > 23 || minute > 59 || second > 59) return NO;
  if ([m rangeAtIndex:7].location != NSNotFound) {
    NSInteger offHour = groupInt(s, m, 8), offMinute = groupInt(s, m, 9);
    if (offMinute > 59 || offHour > 14 || (offHour == 14 && offMinute != 0)) return NO;
  }
  return YES;
}

// ---- K-ATTR custody -------------------------------------------------------

// SPKI of a P-256 key = this fixed header + the 65-byte X9.63 point (91 bytes).
static const uint8_t kSpkiHeader[] = {0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
                                      0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00};

static BOOL isP256Spki(NSData *spki) {
  return spki != nil && spki.length == sizeof(kSpkiHeader) + 65 &&
         memcmp(spki.bytes, kSpkiHeader, sizeof(kSpkiHeader)) == 0 &&
         ((const uint8_t *)spki.bytes)[sizeof(kSpkiHeader)] == 0x04;
}

static NSDictionary *pinQuery(void) {
  return @{
    (id)kSecClass : (id)kSecClassGenericPassword,
    (id)kSecAttrService : kPinService,
    (id)kSecAttrAccount : kPinAccount,
  };
}

// Attribute-only lookup: never reads the secret, so it never prompts. True
// when the item exists and its comment is a well-formed P-256 SPKI.
static BOOL pinIsEnrolled(void) {
  NSMutableDictionary *query = [pinQuery() mutableCopy];
  query[(id)kSecReturnAttributes] = @YES;
  query[(id)kSecMatchLimit] = (id)kSecMatchLimitOne;
  CFTypeRef found = NULL;
  if (SecItemCopyMatching((__bridge CFDictionaryRef)query, &found) != errSecSuccess || found == NULL) return NO;
  NSDictionary *attrs = CFBridgingRelease(found);
  id comment = attrs[(id)kSecAttrComment];
  if (![comment isKindOfClass:[NSString class]]) return NO;
  return isP256Spki([[NSData alloc] initWithBase64EncodedString:comment options:0]);
}

// Reads this item's secret (the trusted binary reads it silently) and signs
// the exact message bytes: ECDSA over SHA-256, DER encoded, base64 out.
static BOOL signWithPinnedKey(NSData *message, NSString *__autoreleasing *signatureOut) {
  NSMutableDictionary *query = [pinQuery() mutableCopy];
  query[(id)kSecReturnData] = @YES;
  query[(id)kSecMatchLimit] = (id)kSecMatchLimitOne;
  CFTypeRef found = NULL;
  if (SecItemCopyMatching((__bridge CFDictionaryRef)query, &found) != errSecSuccess || found == NULL) return NO;
  NSData *privateRep = CFBridgingRelease(found);
  NSDictionary *keyAttrs = @{
    (id)kSecAttrKeyType : (id)kSecAttrKeyTypeECSECPrimeRandom,
    (id)kSecAttrKeyClass : (id)kSecAttrKeyClassPrivate,
    (id)kSecAttrKeySizeInBits : @256,
  };
  SecKeyRef key = SecKeyCreateWithData((__bridge CFDataRef)privateRep, (__bridge CFDictionaryRef)keyAttrs, NULL);
  if (key == NULL) return NO;
  NSData *signature = CFBridgingRelease(SecKeyCreateSignature(key, kSecKeyAlgorithmECDSASignatureMessageX962SHA256,
                                                              (__bridge CFDataRef)message, NULL));
  CFRelease(key);
  if (signature == nil || signature.length == 0) return NO;
  *signatureOut = [signature base64EncodedStringWithOptions:0];
  return YES;
}

static int notEnrolled(void) { return emit(kExitUnavailable, @"{\"v\":1,\"canEvaluate\":true,\"enrolled\":false}"); }

// Deletes the pin item. An absent item is success. The deletion is by the
// binary the item trusts (install.sh unenrols with the old binary); any other
// binary would raise a Keychain sheet, which is the property being relied on.
static int runUnenrol(void) {
  OSStatus st = SecItemDelete((__bridge CFDictionaryRef)pinQuery());
  if (st == errSecSuccess || st == errSecItemNotFound) return emit(kExitOk, @"{\"v\":1,\"enrolled\":false}");
  return emit(kExitUnavailable, [NSString stringWithFormat:@"{\"v\":1,\"enrolled\":true,\"error\":%d}", (int)st]);
}

// Creates a fresh software P-256 key and stores it as the secret of the pin
// item, whose access list trusts this binary alone and whose comment is the
// public key. Replaces an earlier pin (a new install gets a new key).
static int runEnrol(void) {
  if (pinIsEnrolled()) {
    int removed = runUnenrol();
    if (removed != kExitOk) return removed;
  }
  NSDictionary *keyAttrs = @{
    (id)kSecAttrKeyType : (id)kSecAttrKeyTypeECSECPrimeRandom,
    (id)kSecAttrKeySizeInBits : @256,
  };
  SecKeyRef privateKey = SecKeyCreateRandomKey((__bridge CFDictionaryRef)keyAttrs, NULL);
  if (privateKey == NULL) return internalError();
  SecKeyRef publicKey = SecKeyCopyPublicKey(privateKey);
  NSData *privateRep = CFBridgingRelease(SecKeyCopyExternalRepresentation(privateKey, NULL));
  NSData *publicRep = publicKey != NULL ? CFBridgingRelease(SecKeyCopyExternalRepresentation(publicKey, NULL)) : nil;
  CFRelease(privateKey);
  if (publicKey != NULL) CFRelease(publicKey);
  if (privateRep == nil || publicRep == nil) return internalError();
  NSMutableData *spki = [NSMutableData dataWithBytes:kSpkiHeader length:sizeof(kSpkiHeader)];
  [spki appendData:publicRep];
  if (!isP256Spki(spki)) return internalError();

  SecTrustedApplicationRef self_ = NULL;
  OSStatus st = SecTrustedApplicationCreateFromPath(NULL, &self_);
  if (st != errSecSuccess) return emit(kExitUnavailable, [NSString stringWithFormat:@"{\"v\":1,\"enrolled\":false,\"error\":%d}", (int)st]);
  SecAccessRef access = NULL;
  st = SecAccessCreate((__bridge CFStringRef)kPinLabel, (__bridge CFArrayRef) @[ (__bridge id)self_ ], &access);
  CFRelease(self_);
  if (st != errSecSuccess) return emit(kExitUnavailable, [NSString stringWithFormat:@"{\"v\":1,\"enrolled\":false,\"error\":%d}", (int)st]);

  NSMutableDictionary *item = [pinQuery() mutableCopy];
  item[(id)kSecAttrLabel] = kPinLabel;
  item[(id)kSecAttrComment] = [spki base64EncodedStringWithOptions:0];
  item[(id)kSecValueData] = privateRep;
  item[(id)kSecAttrAccess] = (__bridge id)access;
  st = SecItemAdd((__bridge CFDictionaryRef)item, NULL);
  CFRelease(access);
  if (st != errSecSuccess) return emit(kExitUnavailable, [NSString stringWithFormat:@"{\"v\":1,\"enrolled\":false,\"error\":%d}", (int)st]);
  return emit(kExitOk, @"{\"v\":1,\"enrolled\":true}");
}

static int runCheck(void) {
  LAContext *context = [[LAContext alloc] init];
  NSError *error = nil;
  BOOL ok = [context canEvaluatePolicy:LAPolicyDeviceOwnerAuthentication error:&error];
  if (!ok) {
    NSInteger code = error != nil ? error.code : 0;
    return emit(kExitUnavailable,
                [NSString stringWithFormat:@"{\"v\":1,\"canEvaluate\":false,\"error\":%ld}", (long)code]);
  }
  // biometryType is only meaningful after canEvaluatePolicy has run.
  NSString *biometry = context.biometryType == LABiometryTypeTouchID ? @"touch-id" : @"none";
  return emit(kExitOk, [NSString stringWithFormat:@"{\"v\":1,\"canEvaluate\":true,\"biometry\":\"%@\",\"enrolled\":%@}",
                                                  biometry, pinIsEnrolled() ? @"true" : @"false"]);
}

static int runProve(NSString *messageB64) {
  NSRegularExpression *proposalRe = compile(kProposalIdPattern);
  NSRegularExpression *operationRe = compile(kOperationPattern);
  NSRegularExpression *hashRe = compile(kPayloadHashPattern);
  NSRegularExpression *instantRe = compile(kInstantPattern);
  if (proposalRe == nil || operationRe == nil || hashRe == nil || instantRe == nil) return internalError();

  NSData *raw = [[NSData alloc] initWithBase64EncodedString:messageB64 options:0];
  if (raw == nil || raw.length == 0 || raw.length > 4096) return usage();
  id parsed = [NSJSONSerialization JSONObjectWithData:raw options:0 error:nil];
  if (![parsed isKindOfClass:[NSDictionary class]]) return usage();
  NSDictionary *msg = parsed;

  NSSet *expected = [NSSet setWithArray:@[ @"v", @"proposalId", @"operation", @"payloadHash", @"decision", @"approvedAt" ]];
  if (![[NSSet setWithArray:msg.allKeys] isEqualToSet:expected] || msg.count != expected.count) return usage();

  id v = msg[@"v"];
  if (![v isKindOfClass:[NSNumber class]] || CFGetTypeID((__bridge CFTypeRef)v) == CFBooleanGetTypeID() ||
      [v integerValue] != 1 || [v doubleValue] != 1.0)
    return usage();
  if (!fullMatch(proposalRe, msg[@"proposalId"], NULL)) return usage();
  if (!fullMatch(operationRe, msg[@"operation"], NULL)) return usage();
  if (!fullMatch(hashRe, msg[@"payloadHash"], NULL)) return usage();
  if (![msg[@"decision"] isKindOfClass:[NSString class]] || ![msg[@"decision"] isEqualToString:@"approve"]) return usage();
  if (!isIsoInstant(instantRe, msg[@"approvedAt"])) return usage();

  // The prompt text is built here from the vouched-for fields; nothing the
  // caller sent as free text reaches it.
  NSString *reason = [NSString stringWithFormat:@"Approve %@ for request %@ (payload %@)", msg[@"operation"],
                                                [msg[@"proposalId"] substringToIndex:8],
                                                [msg[@"payloadHash"] substringToIndex:8]];

  // No pin, no prompt: an owner is never asked for a gesture that cannot be proved.
  if (!pinIsEnrolled()) return notEnrolled();

  LAContext *context = [[LAContext alloc] init];
  NSError *availability = nil;
  if (![context canEvaluatePolicy:LAPolicyDeviceOwnerAuthentication error:&availability]) {
    NSInteger code = availability != nil ? availability.code : 0;
    return emit(kExitUnavailable,
                [NSString stringWithFormat:@"{\"v\":1,\"canEvaluate\":false,\"error\":%ld}", (long)code]);
  }

  __block BOOL success = NO;
  __block NSInteger failureCode = 0;
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  [context evaluatePolicy:LAPolicyDeviceOwnerAuthentication
          localizedReason:reason
                    reply:^(BOOL result, NSError *error) {
                      success = result;
                      failureCode = error != nil ? error.code : 0;
                      dispatch_semaphore_signal(done);
                    }];
  long waited = dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, kProveCeilingSeconds * NSEC_PER_SEC));
  if (waited != 0) {
    [context invalidate];
    return emit(kExitDenied,
                [NSString stringWithFormat:@"{\"v\":1,\"result\":\"denied\",\"error\":%ld,\"cause\":\"timeout\"}",
                                           (long)kErrorAppCancel]);
  }
  if (success) {
    NSString *signature = nil;
    if (!signWithPinnedKey(raw, &signature)) return notEnrolled();
    return emit(kExitOk, [NSString stringWithFormat:@"{\"v\":1,\"result\":\"proved\",\"scheme\":\"p256\",\"signature\":\"%@\"}", signature]);
  }
  return emit(kExitDenied,
              [NSString stringWithFormat:@"{\"v\":1,\"result\":\"denied\",\"error\":%ld}", (long)failureCode]);
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc == 2 && strcmp(argv[1], "check") == 0) return runCheck();
    if (argc == 2 && strcmp(argv[1], "enrol") == 0) return runEnrol();
    if (argc == 2 && strcmp(argv[1], "unenrol") == 0) return runUnenrol();
    if (argc == 4 && strcmp(argv[1], "prove") == 0 && strcmp(argv[2], "--message") == 0) {
      NSString *message = [NSString stringWithUTF8String:argv[3]];
      if (message == nil) return usage();
      return runProve(message);
    }
    return usage();
  }
  return kExitInternal;
}
