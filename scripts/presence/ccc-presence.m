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
//   enrol                        creates the signing key and the pin item. If
//                                a pin item already exists it is replaced, and
//                                that replacement needs the owner's gesture.
//   unenrol                      deletes the pin item (and with it the key),
//                                after the owner's gesture.
//
// Key custody K-ATTR (09-PRESENCE-SPIKE.md; plan 09-15, R-02): a software
// P-256 key whose private half is the SECRET of one generic-password item
// (service com.claude-command-center, account approval-presence-pin) that
// only this binary is trusted to read. The comment attribute of the same item
// holds the base64 SPKI public key: the PIN a verifier reads attribute-only
// (no secret, no prompt). `prove` signs only after the LocalAuthentication
// check succeeded. A rebuilt binary has a new ad-hoc signature, so it is no
// longer trusted for the old item: install.sh runs `unenrol` with the OLD
// binary, rebuilds, then runs `enrol` with the new one. The item records this
// binary's own code-directory hash in its generic attribute at enrol; `check`
// and `prove` compare it (attribute-only) and report a pin that a different
// binary enrolled as STALE (enrolled false, "stale":true) without prompting,
// instead of letting the headless service run into a Keychain access sheet.
//
// What this does and does not defend (FIX6B; the plain statement is in
// 09-PRESENCE-SPIKE.md "Residual: delete-and-recreate"):
//   - The signing key is released only to this binary, which is signed with the
//     hardened runtime (scripts/presence/build.sh) so DYLD_INSERT_LIBRARIES code
//     cannot run inside it, and it signs only after the owner's gesture.
//   - Every Keychain lookup, delete and add names the account's login keychain
//     explicitly (never the user's search list, which a same-user process can
//     reorder to put a decoy keychain first).
//   - unenrol, and the replacement of an existing item by enrol, need the
//     owner's gesture first, so the helper cannot be used as a silent deleter.
//   - NOT defended: a same-user process deleting the item by some other route
//     and recreating it with its own key. Whether the item's access list gates
//     a foreign delete was not measured by the spike (only a foreign modify,
//     which prompts), so it is treated as ungated. See the spike record.
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
// regex-checked proposalId, operation and payloadHash fields only (prove) or is
// a fixed string (enrol, unenrol).
//
// Test seams: the blocks between HARNESS-SEAM-BEGIN/END comments are the only
// places that touch the Keychain or read this binary's own signature.
// scripts/presence/test-validation.sh builds TEST-ONLY copies of this file with
// those blocks replaced, so no test reads or writes a product item. The seams are
// comments here; nothing in this file switches behaviour at run time.

#import <Foundation/Foundation.h>
#import <LocalAuthentication/LocalAuthentication.h>
#import <Security/Security.h>
#include <pwd.h>
#include <unistd.h>

// SecAccess, SecTrustedApplication and SecKeychain are the only way to give a legacy
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

static NSString *const kEnrolReason = @"Replace the Claude Command Center approval presence key";
static NSString *const kUnenrolReason = @"Remove the Claude Command Center approval presence key";

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

// The login keychain of the account running this process, from the passwd
// database (never HOME, which a same-user parent controls). nil when the
// account has no usable home directory.
static NSString *loginKeychainPath(void) {
  struct passwd *entry = getpwuid(getuid());
  if (entry == NULL || entry->pw_dir == NULL || entry->pw_dir[0] != '/') return nil;
  return [[NSString stringWithUTF8String:entry->pw_dir] stringByAppendingPathComponent:@"Library/Keychains/login.keychain-db"];
}

// The login keychain as an object usable in a query, or nil. Opening a
// SecKeychainRef reads nothing and creates nothing; a missing file only makes
// the later query fail.
static id loginKeychain(void) {
  NSString *path = loginKeychainPath();
  if (path == nil) return nil;
  SecKeychainRef keychain = NULL;
  if (SecKeychainOpen([path fileSystemRepresentation], &keychain) != errSecSuccess || keychain == NULL) return nil;
  return CFBridgingRelease(keychain);
}

static NSDictionary *pinBaseQuery(void) {
  return @{
    (id)kSecClass : (id)kSecClassGenericPassword,
    (id)kSecAttrService : kPinService,
    (id)kSecAttrAccount : kPinAccount,
  };
}

// The pin's lookup/delete query, restricted to the login keychain. nil when the
// login keychain cannot be named (every caller then fails closed).
static NSDictionary *pinScopedQuery(void) {
  id keychain = loginKeychain();
  if (keychain == nil) return nil;
  NSMutableDictionary *query = [pinBaseQuery() mutableCopy];
  query[(id)kSecMatchSearchList] = @[ keychain ];
  return query;
}

// HARNESS-SEAM-BEGIN own-cdhash
// This binary's own code-directory hash (what the Keychain access list pins for an ad-hoc binary).
static NSData *ownCdhash(void) {
  SecCodeRef code = NULL;
  if (SecCodeCopySelf(kSecCSDefaultFlags, &code) != errSecSuccess || code == NULL) return nil;
  CFDictionaryRef info = NULL;
  OSStatus st = SecCodeCopySigningInformation((SecStaticCodeRef)code, kSecCSSigningInformation, &info);
  CFRelease(code);
  if (st != errSecSuccess || info == NULL) return nil;
  NSDictionary *signing = CFBridgingRelease(info);
  id unique = signing[(id)kSecCodeInfoUnique];
  return [unique isKindOfClass:[NSData class]] && [(NSData *)unique length] > 0 ? unique : nil;
}
// HARNESS-SEAM-END own-cdhash

// HARNESS-SEAM-BEGIN pin-lookup
// Attribute-only lookup of the pin item in the login keychain: never reads the secret, so it never prompts.
static OSStatus pinLookup(NSDictionary *__autoreleasing *attributesOut) {
  NSDictionary *scoped = pinScopedQuery();
  if (scoped == nil) return errSecNoSuchKeychain;
  NSMutableDictionary *query = [scoped mutableCopy];
  query[(id)kSecReturnAttributes] = @YES;
  query[(id)kSecMatchLimit] = (id)kSecMatchLimitOne;
  CFTypeRef found = NULL;
  OSStatus st = SecItemCopyMatching((__bridge CFDictionaryRef)query, &found);
  if (st == errSecSuccess) {
    id attributes = found != NULL ? CFBridgingRelease(found) : nil;
    if (![attributes isKindOfClass:[NSDictionary class]]) return errSecInternalError;
    *attributesOut = attributes;
  }
  return st;
}
// HARNESS-SEAM-END pin-lookup

// HARNESS-SEAM-BEGIN pin-sign
// Reads this item's secret (the trusted binary reads it silently; with Keychain interaction disabled, any
// other binary fails fast instead of raising a sheet) and signs the exact message bytes: ECDSA over SHA-256,
// DER encoded, base64 out.
static BOOL signWithPinnedKey(NSData *message, NSString *__autoreleasing *signatureOut) {
  NSDictionary *scoped = pinScopedQuery();
  if (scoped == nil) return NO;
  NSMutableDictionary *query = [scoped mutableCopy];
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
// HARNESS-SEAM-END pin-sign

// HARNESS-SEAM-BEGIN pin-delete
// Deletes the pin item from the login keychain. This binary is the item's trusted application; whether a
// DIFFERENT binary's delete of the same item raises a Keychain sheet was not measured (see the spike record,
// "Residual: delete-and-recreate"), so nothing here relies on it. The owner's gesture precedes every call.
static OSStatus deletePinItem(void) {
  NSDictionary *scoped = pinScopedQuery();
  if (scoped == nil) return errSecNoSuchKeychain;
  return SecItemDelete((__bridge CFDictionaryRef)scoped);
}
// HARNESS-SEAM-END pin-delete

// HARNESS-SEAM-BEGIN pin-add
// Stores the pin in the login keychain only (kSecUseKeychain), with an access list that trusts this binary alone.
static OSStatus addPinItem(NSString *comment, NSData *secret, NSData *cdhash, SecAccessRef access) {
  id keychain = loginKeychain();
  if (keychain == nil) return errSecNoSuchKeychain;
  NSMutableDictionary *item = [pinBaseQuery() mutableCopy];
  item[(id)kSecAttrLabel] = kPinLabel;
  item[(id)kSecAttrComment] = comment;
  item[(id)kSecAttrGeneric] = cdhash;
  item[(id)kSecValueData] = secret;
  item[(id)kSecAttrAccess] = (__bridge id)access;
  item[(id)kSecUseKeychain] = keychain;
  return SecItemAdd((__bridge CFDictionaryRef)item, NULL);
}
// HARNESS-SEAM-END pin-add

typedef NS_ENUM(int, PinState) {
  PinAbsent,   // no item, or one whose comment is not a P-256 SPKI
  PinStale,    // an item this binary did not enrol (rebuilt without re-enrol, or an older enrol)
  PinCurrent,  // enrolled by this very binary
};

// Attribute-only. A pin is current only when its comment is a P-256 SPKI and its generic attribute is this
// binary's own code-directory hash; the secret is never read and nothing is prompted.
static PinState pinState(void) {
  NSDictionary *attributes = nil;
  if (pinLookup(&attributes) != errSecSuccess || attributes == nil) return PinAbsent;
  id comment = attributes[(id)kSecAttrComment];
  if (![comment isKindOfClass:[NSString class]]) return PinAbsent;
  if (!isP256Spki([[NSData alloc] initWithBase64EncodedString:comment options:0])) return PinAbsent;
  id recorded = attributes[(id)kSecAttrGeneric];
  NSData *own = ownCdhash();
  if (own == nil || ![recorded isKindOfClass:[NSData class]] || ![recorded isEqualToData:own]) return PinStale;
  return PinCurrent;
}

static int notEnrolled(BOOL stale) {
  return emit(kExitUnavailable, stale ? @"{\"v\":1,\"canEvaluate\":true,\"enrolled\":false,\"stale\":true}"
                                      : @"{\"v\":1,\"canEvaluate\":true,\"enrolled\":false}");
}

// Asks the OS for Touch ID or the password. kExitOk when the owner authenticated; otherwise the exit code
// (unavailable or denied) with the closed result line in *line. The reason text is the caller's argument, built
// from fixed strings or validated fields only.
static int ownerGesture(NSString *reason, NSString *__autoreleasing *line) {
  LAContext *context = [[LAContext alloc] init];
  NSError *availability = nil;
  if (![context canEvaluatePolicy:LAPolicyDeviceOwnerAuthentication error:&availability]) {
    NSInteger code = availability != nil ? availability.code : 0;
    *line = [NSString stringWithFormat:@"{\"v\":1,\"canEvaluate\":false,\"error\":%ld}", (long)code];
    return kExitUnavailable;
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
    *line = [NSString stringWithFormat:@"{\"v\":1,\"result\":\"denied\",\"error\":%ld,\"cause\":\"timeout\"}",
                                       (long)kErrorAppCancel];
    return kExitDenied;
  }
  if (success) return kExitOk;
  *line = [NSString stringWithFormat:@"{\"v\":1,\"result\":\"denied\",\"error\":%ld}", (long)failureCode];
  return kExitDenied;
}

// Removes the pin item after the owner's gesture. kExitOk when no item exists (nothing to protect, no
// gesture) or when it was deleted (an item that vanishes during the delete counts as deleted); otherwise the
// exit code with the closed line already emitted. Whatever is at the pin's name is removed, a malformed leftover
// included: a stray item would make the later add fail for good.
static int removePinItem(NSString *reason) {
  NSDictionary *existing = nil;
  OSStatus found = pinLookup(&existing);
  if (found == errSecItemNotFound) return kExitOk;
  if (found != errSecSuccess) return emit(kExitUnavailable, [NSString stringWithFormat:@"{\"v\":1,\"error\":%d}", (int)found]);
  NSString *line = nil;
  int gesture = ownerGesture(reason, &line);
  if (gesture != kExitOk) return emit(gesture, line);
  OSStatus st = deletePinItem();
  if (st == errSecSuccess || st == errSecItemNotFound) return kExitOk;
  return emit(kExitUnavailable, [NSString stringWithFormat:@"{\"v\":1,\"enrolled\":true,\"error\":%d}", (int)st]);
}

static int runUnenrol(void) {
  int removed = removePinItem(kUnenrolReason);
  if (removed != kExitOk) return removed;
  return emit(kExitOk, @"{\"v\":1,\"enrolled\":false}");
}

// Creates a fresh software P-256 key and stores it as the secret of the pin
// item, whose access list trusts this binary alone and whose comment is the
// public key. Replaces an earlier pin (a new install gets a new key); replacing
// an existing item needs the owner's gesture, a first enrol does not.
static int runEnrol(void) {
  NSData *cdhash = ownCdhash();
  if (cdhash == nil) return internalError();
  int removed = removePinItem(kEnrolReason);
  if (removed != kExitOk) return removed;

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

  st = addPinItem([spki base64EncodedStringWithOptions:0], privateRep, cdhash, access);
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
  PinState state = pinState();
  return emit(kExitOk, [NSString stringWithFormat:@"{\"v\":1,\"canEvaluate\":true,\"biometry\":\"%@\",\"enrolled\":%@%@}",
                                                  biometry, state == PinCurrent ? @"true" : @"false",
                                                  state == PinStale ? @",\"stale\":true" : @""]);
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

  // No current pin, no prompt: an owner is never asked for a gesture that cannot be proved. A pin another
  // binary enrolled (a rebuild without re-enrol) is reported as stale, before any prompt and before any secret read.
  PinState state = pinState();
  if (state != PinCurrent) return notEnrolled(state == PinStale);

  NSString *line = nil;
  int gesture = ownerGesture(reason, &line);
  if (gesture != kExitOk) return emit(gesture, line);

  NSString *signature = nil;
  // The owner authenticated but the key could not be used: a closed line of its own, not "not enrolled".
  if (!signWithPinnedKey(raw, &signature)) return emit(kExitUnavailable, @"{\"v\":1,\"error\":\"signing-failed\"}");
  return emit(kExitOk, [NSString stringWithFormat:@"{\"v\":1,\"result\":\"proved\",\"scheme\":\"p256\",\"signature\":\"%@\"}", signature]);
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    // The lookup and the secret read must never raise a Keychain sheet: a headless caller (the LaunchAgent
    // service) cannot answer one, and an owner who sees one is invited to press Always Allow. With interaction
    // off a binary the item does not trust fails fast (errSecInteractionNotAllowed) instead.
    if (argc == 2 && strcmp(argv[1], "check") == 0) {
      SecKeychainSetUserInteractionAllowed(FALSE);
      return runCheck();
    }
    if (argc == 2 && strcmp(argv[1], "enrol") == 0) return runEnrol();
    if (argc == 2 && strcmp(argv[1], "unenrol") == 0) return runUnenrol();
    if (argc == 4 && strcmp(argv[1], "prove") == 0 && strcmp(argv[2], "--message") == 0) {
      SecKeychainSetUserInteractionAllowed(FALSE);
      NSString *message = [NSString stringWithUTF8String:argv[3]];
      if (message == nil) return usage();
      return runProve(message);
    }
    return usage();
  }
  return kExitInternal;
}
