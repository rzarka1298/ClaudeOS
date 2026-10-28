// ccc-presence: OS-mediated owner-presence check for the approval gate
// (APPR-11, D-01 as amended by R-01). Objective-C with ARC, compiled locally
// by scripts/presence/build.sh; no binary is committed.
//
// Subcommands (argv only -- stdin is never read, no environment variable is
// consulted):
//   check                        canEvaluatePolicy only; never prompts.
//   prove --message <base64>     validates the message, builds the prompt
//                                text ITSELF from the validated fields, then
//                                asks the OS for Touch ID or the password.
//
// Exit codes (closed): 0 ok, 2 usage, 3 unavailable, 4 denied, 5 internal.
// Every outcome prints exactly one JSON line on stdout.
//
// There is no --reason argument and no code path that copies caller text
// into the prompt (T-09-01): the reason string is assembled below from the
// regex-checked proposalId, operation and payloadHash fields only.

#import <Foundation/Foundation.h>
#import <LocalAuthentication/LocalAuthentication.h>

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
    @"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$";

static const int64_t kProveCeilingSeconds = 60;
static const NSInteger kErrorAppCancel = -9;  // LAErrorAppCancel

static int emit(int code, NSString *line) {
  fputs([[line stringByAppendingString:@"\n"] UTF8String], stdout);
  fflush(stdout);
  return code;
}

static int usage(void) { return emit(kExitUsage, @"{\"v\":1,\"error\":\"usage\"}"); }

static BOOL matches(NSString *pattern, id value) {
  if (![value isKindOfClass:[NSString class]]) return NO;
  NSRange whole = NSMakeRange(0, [(NSString *)value length]);
  NSRegularExpression *re =
      [NSRegularExpression regularExpressionWithPattern:pattern options:0 error:nil];
  NSTextCheckingResult *m = [re firstMatchInString:value options:0 range:whole];
  return m != nil && NSEqualRanges(m.range, whole);
}

static BOOL isIsoInstant(id value) {
  if (!matches(kInstantPattern, value)) return NO;
  NSISO8601DateFormatter *plain = [[NSISO8601DateFormatter alloc] init];
  if ([plain dateFromString:value] != nil) return YES;
  NSISO8601DateFormatter *frac = [[NSISO8601DateFormatter alloc] init];
  frac.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
  return [frac dateFromString:value] != nil;
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
  return emit(kExitOk,
              [NSString stringWithFormat:@"{\"v\":1,\"canEvaluate\":true,\"biometry\":\"%@\"}", biometry]);
}

static int runProve(NSString *messageB64) {
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
  if (!matches(kProposalIdPattern, msg[@"proposalId"])) return usage();
  if (!matches(kOperationPattern, msg[@"operation"])) return usage();
  if (!matches(kPayloadHashPattern, msg[@"payloadHash"])) return usage();
  if (![msg[@"decision"] isKindOfClass:[NSString class]] || ![msg[@"decision"] isEqualToString:@"approve"]) return usage();
  if (!isIsoInstant(msg[@"approvedAt"])) return usage();

  // The prompt text is built here from the vouched-for fields; nothing the
  // caller sent as free text reaches it.
  NSString *reason = [NSString stringWithFormat:@"Approve %@ for request %@ (payload %@)", msg[@"operation"],
                                                [msg[@"proposalId"] substringToIndex:8],
                                                [msg[@"payloadHash"] substringToIndex:8]];

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
                [NSString stringWithFormat:@"{\"v\":1,\"result\":\"denied\",\"error\":%ld}", (long)kErrorAppCancel]);
  }
  if (success) return emit(kExitOk, @"{\"v\":1,\"result\":\"proved\"}");
  return emit(kExitDenied,
              [NSString stringWithFormat:@"{\"v\":1,\"result\":\"denied\",\"error\":%ld}", (long)failureCode]);
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc == 2 && strcmp(argv[1], "check") == 0) return runCheck();
    if (argc == 4 && strcmp(argv[1], "prove") == 0 && strcmp(argv[2], "--message") == 0) {
      NSString *message = [NSString stringWithUTF8String:argv[3]];
      if (message == nil) return usage();
      return runProve(message);
    }
    return usage();
  }
  return kExitInternal;
}
