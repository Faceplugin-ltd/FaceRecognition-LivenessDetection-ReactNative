#import "FaceRecognitionSdk.h"
#import "FaceSdkCompat.h"
#import <UIKit/UIKit.h>
#import <CoreImage/CoreImage.h>
#import <QuartzCore/QuartzCore.h>
#import <React/RCTLog.h>
#import <React/RCTUtils.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

@interface FRSFolderPicker : NSObject <UIDocumentPickerDelegate>
@property (nonatomic, copy) RCTPromiseResolveBlock resolve;
@end

static FRSFolderPicker *gFolderPicker;

@implementation FRSFolderPicker

- (void)documentPicker:(UIDocumentPickerViewController *)controller didPickDocumentsAtURLs:(NSArray<NSURL *> *)urls {
  NSURL *folder = urls.firstObject;
  NSMutableArray *out = [NSMutableArray array];
  if (folder != nil) {
    BOOL access = [folder startAccessingSecurityScopedResource];
    NSArray<NSURL *> *items = [[NSFileManager defaultManager]
        contentsOfDirectoryAtURL:folder
      includingPropertiesForKeys:nil
                         options:NSDirectoryEnumerationSkipsHiddenFiles
                           error:nil];
    NSSet *exts = [NSSet setWithArray:@[ @"png", @"jpg", @"jpeg", @"heic", @"heif", @"bmp", @"webp" ]];
    NSString *tmp = [NSTemporaryDirectory() stringByAppendingPathComponent:@"frs_import"];
    [[NSFileManager defaultManager] createDirectoryAtPath:tmp withIntermediateDirectories:YES attributes:nil error:nil];
    NSArray<NSURL *> *sorted = [items sortedArrayUsingComparator:^NSComparisonResult(NSURL *a, NSURL *b) {
      return [a.lastPathComponent.lowercaseString compare:b.lastPathComponent.lowercaseString];
    }];
    for (NSURL *url in sorted) {
      if (![exts containsObject:url.pathExtension.lowercaseString]) {
        continue;
      }
      NSString *dest = [tmp stringByAppendingPathComponent:url.lastPathComponent];
      [[NSFileManager defaultManager] removeItemAtPath:dest error:nil];
      [[NSFileManager defaultManager] copyItemAtURL:url toURL:[NSURL fileURLWithPath:dest] error:nil];
      [out addObject:@{
        @"uri" : [NSURL fileURLWithPath:dest].absoluteString ?: dest,
        @"fileName" : url.lastPathComponent ?: @""
      }];
    }
    if (access) {
      [folder stopAccessingSecurityScopedResource];
    }
  }
  if (self.resolve) {
    self.resolve(out);
  }
  gFolderPicker = nil;
}

- (void)documentPickerWasCancelled:(UIDocumentPickerViewController *)controller {
  if (self.resolve) {
    self.resolve(@[]);
  }
  gFolderPicker = nil;
}

@end

#if __has_include(<facerecognitionsdk/FaceRecognitionSDK.h>)
#import <facerecognitionsdk/FaceRecognitionSDK.h>
#define FRS_HAS_SDK 1
#elif __has_include("FaceRecognitionSDK.h")
#import "FaceRecognitionSDK.h"
#define FRS_HAS_SDK 1
#endif

/** App-private storage root for the demo gallery (Library/Application Support). */
static NSString *FRSFilesDir(void)
{
  NSArray *paths = NSSearchPathForDirectoriesInDomains(NSApplicationSupportDirectory, NSUserDomainMask, YES);
  NSString *dir = paths.firstObject ?: NSTemporaryDirectory();
  [[NSFileManager defaultManager] createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
  return dir;
}

@implementation FaceRecognitionSdk {
  BOOL hasListeners;
  BOOL videoFrameBusy;
  UIImage *lastLiveImage;
  NSInteger lastLiveWidth;
  NSInteger lastLiveHeight;
}

RCT_EXPORT_MODULE()

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (NSArray<NSString *> *)supportedEvents
{
  return @[ @"FaceRecognitionVideoWorkerEvent" ];
}

- (void)startObserving
{
  hasListeners = YES;
}

- (void)stopObserving
{
  hasListeners = NO;
}

- (void)emitVideoWorkerEvent:(NSString *)json
{
  if (!hasListeners) {
    return;
  }
  NSString *payload = json ?: @"{}";
  if ([NSThread isMainThread]) {
    [self sendEventWithName:@"FaceRecognitionVideoWorkerEvent" body:@{ @"json": payload }];
  } else {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (!self->hasListeners) {
        return;
      }
      [self sendEventWithName:@"FaceRecognitionVideoWorkerEvent" body:@{ @"json": payload }];
    });
  }
}

- (NSDictionary *)constantsToExport
{
  return @{
    @"SDK_SUCCESS": @(0),
    @"SDK_LICENSE_INVALID": @(1),
    @"SDK_LICENSE_EXPIRED": @(2),
    @"SDK_NOT_ACTIVATED": @(3),
    @"SDK_INIT_FAILED": @(4),
    @"DETECT_POSE": @(1 << 0),
    @"DETECT_LANDMARKS": @(1 << 1),
    @"DETECT_AGE": @(1 << 2),
    @"DETECT_GENDER": @(1 << 3),
    @"DETECT_EMOTION": @(1 << 4),
    @"DETECT_MASK": @(1 << 5),
    @"DETECT_QUALITY": @(1 << 6),
    @"DETECT_FACE_QUALITY": @(1 << 7),
    @"DETECT_EYES": @(1 << 8),
    @"DETECT_LIVENESS": @(1 << 9),
    @"DETECT_GLASSES": @(1 << 11),
    @"DETECT_LIVENESS_ACCURATE": @(1 << 16),
    @"DETECT_ALL": @(-1),
    @"LANDMARK_MODE_14": @(14),
    @"LANDMARK_MODE_68": @(68),
    @"LANDMARK_MODE_468": @(468),
    @"MATCH_THRESHOLD": @(0.8),
    @"LIVENESS_THRESHOLD": @(0.5),
    @"ENGINE": @"ios",
    @"SDK_VERSION": @"Face Recognition SDK",
    @"FILES_DIR": FRSFilesDir(),
    // The iOS framework reports an emotion label only: no smile or mouth-open score.
    @"SUPPORTS_SMILE": @NO,
    @"SUPPORTS_MOUTH_OPEN": @NO,
  };
}

static dispatch_queue_t FRSQueue(void)
{
  static dispatch_queue_t q;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    q = dispatch_queue_create("com.facerecognitionsdk.bridge", DISPATCH_QUEUE_SERIAL);
  });
  return q;
}

static UIImage *FRSImageFromUriOrBase64(NSString *uriOrBase64)
{
  if (uriOrBase64 == nil || uriOrBase64.length == 0) {
    return nil;
  }

  BOOL looksBase64 = [uriOrBase64 hasPrefix:@"data:"] ||
    ([uriOrBase64 length] > 256 &&
     [uriOrBase64 rangeOfString:@"://"].location == NSNotFound &&
     ![uriOrBase64 hasPrefix:@"/"] &&
     ![uriOrBase64 hasPrefix:@"file:"]);

  if (looksBase64) {
    NSString *payload = uriOrBase64;
    NSRange range = [uriOrBase64 rangeOfString:@"base64,"];
    if (range.location != NSNotFound) {
      payload = [uriOrBase64 substringFromIndex:range.location + range.length];
    }
    NSData *data = [[NSData alloc] initWithBase64EncodedString:payload options:NSDataBase64DecodingIgnoreUnknownCharacters];
    if (data == nil) {
      return nil;
    }
    return [UIImage imageWithData:data];
  }

  if ([uriOrBase64 hasPrefix:@"/"] || [uriOrBase64 hasPrefix:@"file:"]) {
    NSString *path = uriOrBase64;
    if ([path hasPrefix:@"file:"]) {
      NSURL *fileURL = [NSURL URLWithString:path];
      path = fileURL.path ?: path;
    }
    UIImage *fromFile = [UIImage imageWithContentsOfFile:path];
    if (fromFile != nil) {
      return fromFile;
    }
  }

  NSURL *url = [NSURL URLWithString:uriOrBase64];
  if (url == nil) {
    return nil;
  }
  NSData *data = [NSData dataWithContentsOfURL:url];
  if (data == nil) {
    return nil;
  }
  return [UIImage imageWithData:data];
}

static UIImage *FRSFixOrientation(UIImage *image)
{
  if (image == nil) {
    return nil;
  }
  // Always bake into a CGImage bitmap. VisionCamera takeSnapshot builds a
  // CIImage-backed UIImage; jpegData often leaves landscape sensor pixels with
  // orientation=Up, so an early-return on .Up would feed sideways frames.
  if (image.imageOrientation == UIImageOrientationUp && image.scale == 1.0 && image.CGImage != nil) {
    return image;
  }
  CGSize pixelSize = CGSizeMake(image.size.width * image.scale, image.size.height * image.scale);
  if (pixelSize.width < 1 || pixelSize.height < 1) {
    return nil;
  }
  UIGraphicsImageRendererFormat *format = [UIGraphicsImageRendererFormat defaultFormat];
  format.scale = 1;
  format.opaque = YES;
  UIGraphicsImageRenderer *renderer =
    [[UIGraphicsImageRenderer alloc] initWithSize:pixelSize format:format];
  return [renderer imageWithActions:^(UIGraphicsImageRendererContext * _Nonnull ctx) {
    [image drawInRect:CGRectMake(0, 0, pixelSize.width, pixelSize.height)];
  }];
}

static UIImage *FRSRotateDegrees(UIImage *image, CGFloat degrees)
{
  if (image == nil) {
    return nil;
  }
  const CGFloat radians = degrees * (CGFloat)M_PI / 180.0f;
  CGSize size = CGSizeMake(image.size.width * image.scale, image.size.height * image.scale);
  if (size.width < 1 || size.height < 1) {
    return nil;
  }
  CGRect bound = CGRectApplyAffineTransform(
    CGRectMake(0, 0, size.width, size.height),
    CGAffineTransformMakeRotation(radians));
  CGSize outSize = CGSizeMake(floor(fabs(bound.size.width)), floor(fabs(bound.size.height)));
  if (outSize.width < 1 || outSize.height < 1) {
    return nil;
  }
  UIGraphicsImageRendererFormat *format = [UIGraphicsImageRendererFormat defaultFormat];
  format.scale = 1;
  format.opaque = YES;
  UIGraphicsImageRenderer *renderer =
    [[UIGraphicsImageRenderer alloc] initWithSize:outSize format:format];
  return [renderer imageWithActions:^(UIGraphicsImageRendererContext * _Nonnull ctx) {
    CGContextRef c = ctx.CGContext;
    CGContextTranslateCTM(c, outSize.width * 0.5, outSize.height * 0.5);
    CGContextRotateCTM(c, radians);
    [image drawInRect:CGRectMake(-size.width * 0.5, -size.height * 0.5, size.width, size.height)];
  }];
}

static UIImage *FRSScaledMaxEdge(UIImage *image, CGFloat maxEdge)
{
  if (image == nil) {
    return nil;
  }
  UIImage *upright = FRSFixOrientation(image);
  if (upright == nil) {
    return nil;
  }
  CGFloat pw = upright.size.width * upright.scale;
  CGFloat ph = upright.size.height * upright.scale;
  CGFloat edge = MAX(pw, ph);
  if (edge <= maxEdge) {
    return upright;
  }
  CGFloat scale = maxEdge / edge;
  CGSize size = CGSizeMake(floor(pw * scale), floor(ph * scale));
  UIGraphicsImageRendererFormat *format = [UIGraphicsImageRendererFormat defaultFormat];
  format.scale = 1;
  format.opaque = YES;
  UIGraphicsImageRenderer *renderer =
    [[UIGraphicsImageRenderer alloc] initWithSize:size format:format];
  return [renderer imageWithActions:^(UIGraphicsImageRendererContext * _Nonnull ctx) {
    [upright drawInRect:CGRectMake(0, 0, size.width, size.height)];
  }];
}

/**
 * Bake VisionCamera/EXIF to display-upright pixels only (no front/back logic).
 * JS liveFramePrep owns rotateDegrees; native only applies.
 */
static UIImage *FRSBakeOrientation(UIImage *image)
{
  return FRSFixOrientation(image);
}

/**
 * VisionCamera takeSnapshot is `UIImage(ciImage:)` from the video buffer. jpegData of a
 * CIImage-backed image writes bottom-left origin pixels, so the live JPEG is mirrored on Y.
 * That flip is only right for the front camera. After the back camera's +90 rotation the
 * same flip mirrors the engine image on Y, so the caller turns it off for the back camera.
 */
static UIImage *FRSFlipVertical(UIImage *image)
{
  if (image == nil) {
    return nil;
  }
  CGImageRef cg = image.CGImage;
  if (cg == nil) {
    image = FRSFixOrientation(image);
    cg = image.CGImage;
  }
  if (cg == nil) {
    return image;
  }
  UIImage *tagged = [UIImage imageWithCGImage:cg scale:1.0 orientation:UIImageOrientationDownMirrored];
  return FRSFixOrientation(tagged);
}

static UIImage *FRSApplyLiveTransform(UIImage *image, CGFloat rotateDegrees, CGFloat maxEdge, BOOL flipVertical)
{
  if (image == nil) {
    return nil;
  }
  UIImage *frame = FRSBakeOrientation(image);
  if (frame == nil) {
    return nil;
  }
  CGFloat deg = fmod(rotateDegrees, 360.0);
  if (fabs(deg) > 0.01) {
    frame = FRSRotateDegrees(frame, deg);
  }
  if (frame == nil) {
    return nil;
  }
  if (flipVertical) {
    frame = FRSFlipVertical(frame);
  }
  if (frame == nil) {
    return nil;
  }
  CGFloat edge = maxEdge > 0 ? maxEdge : 640.0;
  return FRSScaledMaxEdge(frame, edge);
}

static NSDictionary *FRSLiveFrameResult(UIImage *image, BOOL ingested, NSString *uri)
{
  CGFloat w = image ? image.size.width * image.scale : 0;
  CGFloat h = image ? image.size.height * image.scale : 0;
  return @{
    @"ingested": @(ingested),
    @"width": @(w),
    @"height": @(h),
    @"uri": uri ?: [NSNull null],
  };
}

static NSString *FRSWriteTempJpeg(UIImage *image, CGFloat quality)
{
  if (image == nil) {
    return nil;
  }
  NSData *data = UIImageJPEGRepresentation(image, quality);
  if (data.length == 0) {
    return nil;
  }
  NSString *name = [NSString stringWithFormat:@"frs_live_%@.jpg", NSUUID.UUID.UUIDString];
  NSString *path = [NSTemporaryDirectory() stringByAppendingPathComponent:name];
  if (![data writeToFile:path atomically:YES]) {
    return nil;
  }
  return [@"file://" stringByAppendingString:path];
}

static id FRSAttrLookup(NSDictionary *attrs, NSArray<NSString *> *keys)
{
  if (![attrs isKindOfClass:[NSDictionary class]]) {
    return nil;
  }
  for (NSString *key in keys) {
    id v = attrs[key];
    if (v != nil) {
      return v;
    }
  }
  return nil;
}

static NSString *FRSAttrValue(id attr)
{
  if ([attr isKindOfClass:[NSDictionary class]]) {
    id v = ((NSDictionary *)attr)[@"value"];
    if (v == nil) {
      return @"";
    }
    return [NSString stringWithFormat:@"%@", v];
  }
  if (attr == nil) {
    return @"";
  }
  return [NSString stringWithFormat:@"%@", attr];
}

static double FRSAttrConfidence(id attr, double fallback)
{
  if ([attr isKindOfClass:[NSDictionary class]]) {
    id c = ((NSDictionary *)attr)[@"confidence"];
    if ([c isKindOfClass:[NSNumber class]]) {
      return [(NSNumber *)c doubleValue];
    }
    if ([c isKindOfClass:[NSString class]]) {
      return [(NSString *)c doubleValue];
    }
  }
  return fallback;
}

/** Map EyesLeft/EyesRight label → closedness score (0 open … 1 closed), matching Android FaceBox. */
static double FRSEyeClosedScore(id attr)
{
  NSString *label = [FRSAttrValue(attr) lowercaseString];
  double conf = FRSAttrConfidence(attr, NAN);
  if ([label containsString:@"clos"]) {
    return isnan(conf) ? 1.0 : MAX(0.0, MIN(1.0, conf));
  }
  if ([label containsString:@"open"]) {
    if (isnan(conf)) {
      return 0.0;
    }
    // Some packs report openness confidence; invert to closedness.
    return MAX(0.0, MIN(1.0, 1.0 - conf));
  }
  if (!isnan(conf)) {
    return MAX(0.0, MIN(1.0, conf));
  }
  return 0.0;
}

static NSString *FRSFeatureB64FromExtractJSON(NSString *json)
{
  if (json == nil) {
    return nil;
  }
  NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
  if (data == nil) {
    return nil;
  }
  id obj = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  if (![obj isKindOfClass:[NSDictionary class]]) {
    return nil;
  }
  NSDictionary *dict = (NSDictionary *)obj;

  // Native iOS/Android FaceJSON: results[].features[].feature  or  features[].feature
  NSArray *results = dict[@"results"];
  if ([results isKindOfClass:[NSArray class]] && results.count > 0) {
    NSDictionary *first = results[0];
    if ([first isKindOfClass:[NSDictionary class]]) {
      NSArray *features = first[@"features"];
      if ([features isKindOfClass:[NSArray class]] && features.count > 0) {
        NSDictionary *f0 = features[0];
        if ([f0 isKindOfClass:[NSDictionary class]]) {
          id b64 = f0[@"feature"];
          if ([b64 isKindOfClass:[NSString class]] && [(NSString *)b64 length] > 0) {
            return (NSString *)b64;
          }
        }
      }
    }
  }
  NSArray *features = dict[@"features"];
  if ([features isKindOfClass:[NSArray class]] && features.count > 0) {
    NSDictionary *f0 = features[0];
    if ([f0 isKindOfClass:[NSDictionary class]]) {
      id b64 = f0[@"feature"];
      if ([b64 isKindOfClass:[NSString class]] && [(NSString *)b64 length] > 0) {
        return (NSString *)b64;
      }
    }
  }

  id feature = dict[@"feature"] ?: dict[@"data"] ?: dict[@"featureBase64"];
  if ([feature isKindOfClass:[NSString class]]) {
    return (NSString *)feature;
  }
  if ([feature isKindOfClass:[NSDictionary class]]) {
    id inner = ((NSDictionary *)feature)[@"data"] ?: ((NSDictionary *)feature)[@"feature"];
    if ([inner isKindOfClass:[NSString class]]) {
      return (NSString *)inner;
    }
  }
  return nil;
}

static NSArray *FRSBoxesFromDetectJSON(NSString *json)
{
  NSMutableArray *out = [NSMutableArray array];
  if (json == nil) {
    return out;
  }
  NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
  id root = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  NSArray *faces = nil;
  if ([root isKindOfClass:[NSDictionary class]]) {
    faces = ((NSDictionary *)root)[@"data"];
    if (![faces isKindOfClass:[NSArray class]]) {
      faces = ((NSDictionary *)root)[@"faces"];
    }
  } else if ([root isKindOfClass:[NSArray class]]) {
    faces = (NSArray *)root;
  }
  if (![faces isKindOfClass:[NSArray class]]) {
    return out;
  }
  for (id item in faces) {
    if (![item isKindOfClass:[NSDictionary class]]) {
      continue;
    }
    NSDictionary *face = (NSDictionary *)item;
    // FaceSdkCompat already returns the canonical flat schema, including templates.
    // Only legacy nested SDK results need conversion below.
    if (face[@"x1"] != nil && face[@"y1"] != nil &&
        face[@"x2"] != nil && face[@"y2"] != nil) {
      [out addObject:[face copy]];
      continue;
    }
    NSDictionary *region = face[@"faceRegion"];
    NSDictionary *pose = face[@"facePose"];
    NSDictionary *attrs = face[@"attributes"];
    NSMutableDictionary *box = [NSMutableDictionary dictionary];
    if (face[@"detectionId"] != nil) box[@"detectionId"] = face[@"detectionId"];
    CGFloat x = [region[@"x"] doubleValue];
    CGFloat y = [region[@"y"] doubleValue];
    CGFloat w = [region[@"width"] doubleValue];
    CGFloat h = [region[@"height"] doubleValue];
    box[@"x1"] = @((int)x);
    box[@"y1"] = @((int)y);
    box[@"x2"] = @((int)(x + w));
    box[@"y2"] = @((int)(y + h));
    box[@"yaw"] = pose[@"yaw"] ?: @0;
    box[@"roll"] = pose[@"roll"] ?: @0;
    box[@"pitch"] = pose[@"pitch"] ?: @0;
    box[@"age"] = @0;
    box[@"gender"] = @0;
    box[@"liveness"] = @0;
    box[@"face_quality"] = @0;
    box[@"face_luminance"] = @0;
    box[@"left_eye_closed"] = @0;
    box[@"right_eye_closed"] = @0;
    box[@"face_occlusion"] = @0;
    box[@"mouth_opened"] = @0;
    box[@"livenessLabel"] = @"";
    box[@"genderLabel"] = @"";
    box[@"emotionLabel"] = @"";
    box[@"maskLabel"] = @"";
    box[@"qualityLabel"] = @"";
    box[@"eyesLeftLabel"] = @"";
    box[@"eyesRightLabel"] = @"";
    box[@"glassesLabel"] = @"";
    box[@"sunglassesLabel"] = @"";
    box[@"occlusionLabel"] = @"";
    box[@"attributes"] = [NSMutableDictionary dictionary];

    // Top-level age (some packs); prefer attributes.Age below.
    if (face[@"age"] != nil) {
      box[@"age"] = @([face[@"age"] intValue]);
    }

    if ([attrs isKindOfClass:[NSDictionary class]]) {
      // Preserve every engine attribute for the Attribute Result UI (Android ResultDetails leftovers).
      NSMutableDictionary *attrOut = [NSMutableDictionary dictionary];
      for (id key in attrs) {
        if (![key isKindOfClass:[NSString class]]) continue;
        id rawAttr = attrs[key];
        NSString *val = FRSAttrValue(rawAttr);
        if (val.length == 0) continue;
        double conf = FRSAttrConfidence(rawAttr, NAN);
        if (!isnan(conf)) {
          attrOut[(NSString *)key] = [NSString stringWithFormat:@"%@ · %.0f%%", val, conf * 100.0];
        } else {
          attrOut[(NSString *)key] = val;
        }
      }
      box[@"attributes"] = attrOut;

      // SDK uses PascalCase keys (Age, Gender, Liveness2D, EyesLeft, …) — same as native iOS App.
      id ageAttr = FRSAttrLookup(attrs, @[ @"Age", @"age" ]);
      NSString *ageVal = FRSAttrValue(ageAttr);
      if (ageVal.length > 0) {
        // "25" or "25-34" → take leading int when possible
        box[@"age"] = @([ageVal intValue]);
      }

      id genderAttr = FRSAttrLookup(attrs, @[ @"Gender", @"gender" ]);
      NSString *genderVal = FRSAttrValue(genderAttr);
      box[@"genderLabel"] = genderVal;
      NSString *gLower = [genderVal lowercaseString];
      if ([gLower hasPrefix:@"m"]) {
        box[@"gender"] = @0;
      } else if ([gLower hasPrefix:@"f"]) {
        box[@"gender"] = @1;
      }

      id emotionAttr = FRSAttrLookup(attrs, @[ @"Emotion", @"emotion" ]);
      box[@"emotionLabel"] = FRSAttrValue(emotionAttr);

      id maskAttr = FRSAttrLookup(attrs, @[ @"MedicalMask", @"Mask", @"mask" ]);
      box[@"maskLabel"] = FRSAttrValue(maskAttr);

      id glassesAttr = FRSAttrLookup(attrs, @[ @"Glasses", @"glasses" ]);
      box[@"glassesLabel"] = FRSAttrValue(glassesAttr);
      id sunAttr = FRSAttrLookup(attrs, @[ @"Sunglasses", @"sunglasses" ]);
      box[@"sunglassesLabel"] = FRSAttrValue(sunAttr);

      id livAttr = FRSAttrLookup(attrs, @[ @"Liveness2D", @"liveness", @"Liveness" ]);
      NSString *livVal = FRSAttrValue(livAttr);
      box[@"livenessLabel"] = livVal;
      double livConf = FRSAttrConfidence(livAttr, NAN);
      if (!isnan(livConf)) {
        box[@"liveness"] = @(livConf);
      } else if (livVal.length > 0) {
        NSString *ll = [livVal lowercaseString];
        box[@"liveness"] = ([ll containsString:@"real"] || [ll containsString:@"genuine"] || [ll containsString:@"live"])
          ? @1.0
          : @0.0;
      }

      id qualityAttr = FRSAttrLookup(attrs, @[ @"FaceQuality", @"ExpressionLevel", @"face_quality" ]);
      NSString *qVal = FRSAttrValue(qualityAttr);
      box[@"qualityLabel"] = qVal;
      double qConf = FRSAttrConfidence(qualityAttr, NAN);
      if (!isnan(qConf)) {
        box[@"face_quality"] = @(qConf);
      } else if (qVal.length > 0) {
        box[@"face_quality"] = @([qVal doubleValue]);
      }

      id eyesL = FRSAttrLookup(attrs, @[ @"EyesLeft", @"eyesLeft" ]);
      id eyesR = FRSAttrLookup(attrs, @[ @"EyesRight", @"eyesRight" ]);
      box[@"eyesLeftLabel"] = FRSAttrValue(eyesL);
      box[@"eyesRightLabel"] = FRSAttrValue(eyesR);
      box[@"left_eye_closed"] = @(FRSEyeClosedScore(eyesL));
      box[@"right_eye_closed"] = @(FRSEyeClosedScore(eyesR));

      id occ = FRSAttrLookup(attrs, @[ @"Occlusion", @"FaceOcclusion", @"occlusion" ]);
      if (occ != nil) {
        NSString *occVal = FRSAttrValue(occ);
        box[@"occlusionLabel"] = occVal;
        NSString *occLower = [occVal lowercaseString];
        double occConf = FRSAttrConfidence(occ, NAN);
        if (!isnan(occConf)) {
          box[@"face_occlusion"] = @(occConf);
        } else if ([occLower containsString:@"occlud"] || [occLower containsString:@"yes"] || [occLower isEqualToString:@"1"]) {
          box[@"face_occlusion"] = @1.0;
        }
      }
    }

    NSArray *points = face[@"facePoints"];
    NSMutableArray *landmarks = [NSMutableArray array];
    if ([points isKindOfClass:[NSArray class]]) {
      for (id pt in points) {
        if (![pt isKindOfClass:[NSDictionary class]]) continue;
        [landmarks addObject:@([pt[@"x"] doubleValue])];
        [landmarks addObject:@([pt[@"y"] doubleValue])];
      }
    }
    box[@"landmarks"] = landmarks;
    box[@"landmarkCount"] = @(landmarks.count / 2);
    [out addObject:box];
  }
  return out;
}

static FaceRecognitionDetectFlags FRSFlagsFromParamJSON(NSString *paramJson)
{
  FaceRecognitionDetectFlags flags = FaceRecognitionDetectPose | FaceRecognitionDetectLandmarks;
  if (paramJson.length == 0) {
    return flags;
  }
  NSData *pdata = [paramJson dataUsingEncoding:NSUTF8StringEncoding];
  NSDictionary *p = [NSJSONSerialization JSONObjectWithData:pdata options:0 error:nil];
  if (![p isKindOfClass:[NSDictionary class]]) {
    return flags;
  }
  if ([p[@"allAttributes"] boolValue]) {
    flags = FaceRecognitionDetectAll;
    // Demo settings: level 0 = High Accuracy, 1 = Light Weight (LiveDetect.livenessOnlyFlags).
    if ([p[@"check_liveness_level"] intValue] == 0) {
      flags = flags | FaceRecognitionDetectLivenessAccurate;
    }
    return flags;
  }

  flags = 0;
  BOOL checkPose = p[@"check_pose"] ? [p[@"check_pose"] boolValue] : YES;
  BOOL checkLandmarks = p[@"check_landmarks"] ? [p[@"check_landmarks"] boolValue] : YES;
  if (checkPose) {
    flags |= FaceRecognitionDetectPose;
  }
  if (checkLandmarks) {
    flags |= FaceRecognitionDetectLandmarks;
  }
  if ([p[@"estimate_age_gender"] boolValue]) {
    flags |= FaceRecognitionDetectAge | FaceRecognitionDetectGender;
  }
  if ([p[@"check_emotion"] boolValue]) {
    flags |= FaceRecognitionDetectEmotion;
  }
  if ([p[@"check_mask"] boolValue]) {
    flags |= FaceRecognitionDetectMask;
  }
  if ([p[@"check_quality"] boolValue]) {
    flags |= FaceRecognitionDetectQuality | FaceRecognitionDetectFaceQuality;
  }
  if ([p[@"check_eye_closeness"] boolValue] || [p[@"check_face_occlusion"] boolValue]) {
    flags |= FaceRecognitionDetectEyes;
  }
  if ([p[@"check_liveness"] boolValue]) {
    flags |= FaceRecognitionDetectLiveness;
    if ([p[@"check_liveness_level"] intValue] == 0) {
      flags |= FaceRecognitionDetectLivenessAccurate;
    }
  }
  if ([p[@"check_glasses"] boolValue]) {
    flags |= FaceRecognitionDetectGlasses;
  }
  if (flags == 0) {
    flags = FaceRecognitionDetectPose | FaceRecognitionDetectLandmarks;
  }
  return flags;
}

static NSString *FRSJsonString(id obj)
{
  if (obj == nil) {
    return @"[]";
  }
  NSError *err = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:obj options:0 error:&err];
  if (data == nil) {
    return @"[]";
  }
  return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @"[]";
}

/** Match Android Utils.cropFace: 1.4× square window scaled to 200×200. */
static UIImage *FRSCropFace(UIImage *image, NSDictionary *box)
{
  if (image == nil || box == nil) {
    return nil;
  }
  CGFloat x1 = [box[@"x1"] doubleValue];
  CGFloat y1 = [box[@"y1"] doubleValue];
  CGFloat x2 = [box[@"x2"] doubleValue];
  CGFloat y2 = [box[@"y2"] doubleValue];
  CGFloat iw = image.size.width * image.scale;
  CGFloat ih = image.size.height * image.scale;
  if (iw < 2 || ih < 2) {
    return nil;
  }
  // The face box with 12% padding, at the source resolution — what ImageUtils.cropFace stores
  // natively. A 1.4x square scaled to 200x200 framed the face wider and threw away detail.
  CGFloat pad = MAX(4.0, MIN(x2 - x1, y2 - y1) * 0.12);
  CGFloat left = MAX(0.0, x1 - pad);
  CGFloat top = MAX(0.0, y1 - pad);
  CGFloat right = MIN(iw, x2 + pad);
  CGFloat bottom = MIN(ih, y2 + pad);
  if (right - left <= 1 || bottom - top <= 1 || image.CGImage == NULL) {
    return nil;
  }
  CGRect rect = CGRectMake(left, top, right - left, bottom - top);
  CGImageRef cg = CGImageCreateWithImageInRect(image.CGImage, rect);
  if (cg == NULL) {
    return nil;
  }
  UIImage *cropped = [UIImage imageWithCGImage:cg scale:1.0 orientation:UIImageOrientationUp];
  CGImageRelease(cg);
  return cropped;
}

static NSString *FRSJpegBase64(UIImage *image)
{
  if (image == nil) {
    return nil;
  }
  NSData *data = UIImageJPEGRepresentation(image, 0.85);
  return [data base64EncodedStringWithOptions:0];
}

#ifndef FRS_HAS_SDK
#define FRS_MISSING_REJECT(promise) reject(@"E_SDK", @"facerecognitionsdk.framework not linked. Download from Google Drive and place under ios/Frameworks/.", nil)
#endif

RCT_EXPORT_METHOD(getMachineCode:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(FRSQueue(), ^{
#ifdef FRS_HAS_SDK
    @try {
      resolve([FaceRecognitionSDK machineCode] ?: @"");
    } @catch (NSException *e) {
      reject(@"E_MACHINE_CODE", e.reason, nil);
    }
#else
    FRS_MISSING_REJECT(resolve);
#endif
  });
}

RCT_EXPORT_METHOD(getLicenseStatus:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(FRSQueue(), ^{
#ifdef FRS_HAS_SDK
    @try {
      resolve([FaceSdkCompat licenseStatusJson] ?: @"{}");
    } @catch (NSException *e) {
      reject(@"E_LICENSE_STATUS", e.reason, nil);
    }
#else
    FRS_MISSING_REJECT(resolve);
#endif
  });
}

RCT_EXPORT_METHOD(setActivation:(NSString *)license
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(FRSQueue(), ^{
#ifdef FRS_HAS_SDK
    @try {
      resolve(@([FaceRecognitionSDK activate:license ?: @""]));
    } @catch (NSException *e) {
      reject(@"E_ACTIVATION", e.reason, nil);
    }
#else
    FRS_MISSING_REJECT(resolve);
#endif
  });
}

RCT_EXPORT_METHOD(init:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(FRSQueue(), ^{
#ifdef FRS_HAS_SDK
    @try {
      resolve(@([FaceRecognitionSDK initSDK]));
    } @catch (NSException *e) {
      reject(@"E_INIT", e.reason, nil);
    }
#else
    FRS_MISSING_REJECT(resolve);
#endif
  });
}

RCT_EXPORT_METHOD(deinit:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(FRSQueue(), ^{
#ifdef FRS_HAS_SDK
    @try {
      [FaceSdkCompat clearDetectedFaces];
      [FaceRecognitionSDK close];
      resolve([NSNull null]);
    } @catch (NSException *e) {
      reject(@"E_DEINIT", e.reason, nil);
    }
#else
    resolve([NSNull null]);
#endif
  });
}

RCT_EXPORT_METHOD(lastLicenseError:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
#ifdef FRS_HAS_SDK
  resolve([FaceRecognitionSDK lastLicenseError] ?: @"");
#else
  resolve(@"");
#endif
}

RCT_EXPORT_METHOD(setLandmarkMode:(nonnull NSNumber *)mode
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(FRSQueue(), ^{
#ifdef FRS_HAS_SDK
    resolve(@(0));
#else
    FRS_MISSING_REJECT(resolve);
#endif
  });
}

RCT_EXPORT_METHOD(getLandmarkMode:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(FRSQueue(), ^{
#ifdef FRS_HAS_SDK
    resolve(@(0));
#else
    resolve(@(68));
#endif
  });
}

RCT_EXPORT_METHOD(detect:(NSString *)imageUri
                  crop:(BOOL)crop
                  flags:(nonnull NSNumber *)flags
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(FRSQueue(), ^{
#ifdef FRS_HAS_SDK
    @try {
      UIImage *image = FRSFixOrientation(FRSImageFromUriOrBase64(imageUri));
      if (image == nil) {
        reject(@"E_IMAGE", @"Could not decode image", nil);
        return;
      }
      NSUInteger flagBits = flags.unsignedIntegerValue;
      NSString *json = nil;
      if (flags.intValue < 0) {
        json = [FaceSdkCompat detectJson:image flags:FaceRecognitionDetectAll];
      } else {
        json = [FaceSdkCompat detectJson:image flags:flagBits];
      }
      resolve(json ?: @"{}");
    } @catch (NSException *e) {
      reject(@"E_DETECT", e.reason, nil);
    }
#else
    FRS_MISSING_REJECT(resolve);
#endif
  });
}

RCT_EXPORT_METHOD(faceDetection:(NSString *)imageUri
                  paramJson:(NSString *)paramJson
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(FRSQueue(), ^{
#ifdef FRS_HAS_SDK
    @try {
      UIImage *image = FRSFixOrientation(FRSImageFromUriOrBase64(imageUri));
      if (image == nil) {
        reject(@"E_IMAGE", @"Could not decode image", nil);
        return;
      }
      NSString *json = [FaceSdkCompat detectJson:image param:paramJson];
      NSArray *boxes = FRSBoxesFromDetectJSON(json);
      resolve(FRSJsonString(boxes));
    } @catch (NSException *e) {
      reject(@"E_FACE_DETECTION", e.reason, nil);
    }
#else
    FRS_MISSING_REJECT(resolve);
#endif
  });
}

RCT_EXPORT_METHOD(estimatorStatus:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(FRSQueue(), ^{
#ifdef FRS_HAS_SDK
    @try {
      resolve(@"{}");
    } @catch (NSException *e) {
      reject(@"E_ESTIMATOR", e.reason, nil);
    }
#else
    resolve(@"{}");
#endif
  });
}

RCT_EXPORT_METHOD(runDocumentsSmoke:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(FRSQueue(), ^{
#ifdef FRS_HAS_SDK
    @try {
      NSArray *paths = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES);
      NSString *docs = paths[0];
      NSString *imagePath = [docs stringByAppendingPathComponent:@"smoke_face.jpg"];
      NSString *estimators = @"{}";
      NSMutableDictionary *payload = [NSMutableDictionary dictionary];
      payload[@"estimators"] = estimators;
      payload[@"image"] = imagePath;
      UIImage *image = [UIImage imageWithContentsOfFile:imagePath];
      if (image == nil) {
        // No smoke image — skip quietly (do not overwrite a previous smoke result).
        resolve(@"{\"ok\":false,\"skipped\":true}");
        return;
      }
      image = FRSFixOrientation(image);
      NSString *raw = [FaceSdkCompat detectJson:image flags:FaceRecognitionDetectAll] ?: @"{}";
      NSArray *boxes = FRSBoxesFromDetectJSON(raw);
      NSString *featB64 = boxes.count > 0
          ? [FaceSdkCompat templateBase64:image faceJson:FRSJsonString(boxes[0])] : @"";
      NSString *featJson = FRSJsonString(@{@"feature": featB64 ?: @""});
      payload[@"ok"] = @(boxes.count > 0 && featB64.length > 0);
      payload[@"faceCount"] = @(boxes.count);
      payload[@"boxes"] = boxes;
      payload[@"rawDetectPreview"] = raw.length > 2000 ? [raw substringToIndex:2000] : raw;
      payload[@"featureLen"] = @(featB64.length);
      payload[@"featureJsonPreview"] = featJson.length > 500 ? [featJson substringToIndex:500] : featJson;
      NSData *out = [NSJSONSerialization dataWithJSONObject:payload options:NSJSONWritingPrettyPrinted error:nil];
      NSString *outPath = [docs stringByAppendingPathComponent:@"facerecognition_smoke.json"];
      [out writeToFile:outPath atomically:YES];
      resolve([[NSString alloc] initWithData:out encoding:NSUTF8StringEncoding] ?: @"{}");
    } @catch (NSException *e) {
      reject(@"E_SMOKE", e.reason, nil);
    }
#else
    resolve(@"{\"ok\":false,\"error\":\"no sdk\"}");
#endif
  });
}

RCT_EXPORT_METHOD(templateExtraction:(NSString *)imageUri
                  faceBoxJson:(NSString *)faceBoxJson
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(FRSQueue(), ^{
#ifdef FRS_HAS_SDK
    @try {
      UIImage *full = FRSFixOrientation(FRSImageFromUriOrBase64(imageUri));
      if (full == nil) {
        reject(@"E_IMAGE", @"Could not decode image", nil);
        return;
      }
      NSString *b64 = [FaceSdkCompat templateBase64:full faceJson:faceBoxJson];
      if (b64.length == 0) {
        reject(@"E_TEMPLATE", @"Template extraction returned no feature", nil);
        return;
      }
      resolve(b64);
    } @catch (NSException *e) {
      reject(@"E_TEMPLATE", e.reason, nil);
    }
#else
    FRS_MISSING_REJECT(resolve);
#endif
  });
}

RCT_EXPORT_METHOD(cropFace:(NSString *)imageUri
                  faceBoxJson:(NSString *)faceBoxJson
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(FRSQueue(), ^{
    @try {
      UIImage *image = FRSFixOrientation(FRSImageFromUriOrBase64(imageUri));
      if (image == nil) {
        reject(@"E_IMAGE", @"Could not decode image", nil);
        return;
      }
      NSData *data = [faceBoxJson dataUsingEncoding:NSUTF8StringEncoding];
      NSDictionary *box = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
      UIImage *cropped = FRSCropFace(image, box);
      NSString *b64 = FRSJpegBase64(cropped);
      if (b64.length == 0) {
        reject(@"E_CROP", @"cropFace failed", nil);
        return;
      }
      resolve(b64);
    } @catch (NSException *e) {
      reject(@"E_CROP", e.reason, nil);
    }
  });
}

RCT_EXPORT_METHOD(extractFeature:(NSString *)imageUri
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(FRSQueue(), ^{
#ifdef FRS_HAS_SDK
    @try {
      UIImage *image = FRSFixOrientation(FRSImageFromUriOrBase64(imageUri));
      if (image == nil) {
        reject(@"E_IMAGE", @"Could not decode image", nil);
        return;
      }
      resolve([FaceSdkCompat extractFeatureJson:image] ?: @"{}");
    } @catch (NSException *e) {
      reject(@"E_FEATURE", e.reason, nil);
    }
#else
    FRS_MISSING_REJECT(resolve);
#endif
  });
}

RCT_EXPORT_METHOD(similarity:(NSString *)feature1B64
                  feature2B64:(NSString *)feature2B64
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(FRSQueue(), ^{
#ifdef FRS_HAS_SDK
    @try {
      NSData *f1 = [[NSData alloc] initWithBase64EncodedString:feature1B64 ?: @"" options:NSDataBase64DecodingIgnoreUnknownCharacters];
      NSData *f2 = [[NSData alloc] initWithBase64EncodedString:feature2B64 ?: @"" options:NSDataBase64DecodingIgnoreUnknownCharacters];
      resolve(@([FaceRecognitionSDK similarityWithFeature1:f1 feature2:f2]));
    } @catch (NSException *e) {
      reject(@"E_SIMILARITY", e.reason, nil);
    }
#else
    FRS_MISSING_REJECT(resolve);
#endif
  });
}

RCT_EXPORT_METHOD(quality:(NSString *)imageUri
                  crop:(BOOL)crop
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(FRSQueue(), ^{
#ifdef FRS_HAS_SDK
    @try {
      UIImage *image = FRSFixOrientation(FRSImageFromUriOrBase64(imageUri));
      if (image == nil) {
        reject(@"E_IMAGE", @"Could not decode image", nil);
        return;
      }
      resolve([FaceSdkCompat qualityJson:image] ?: @"{}");
    } @catch (NSException *e) {
      reject(@"E_QUALITY", e.reason, nil);
    }
#else
    FRS_MISSING_REJECT(resolve);
#endif
  });
}

RCT_EXPORT_METHOD(startVideoWorker:(NSString *)configJson
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  __weak FaceRecognitionSdk *weakSelf = self;
  dispatch_async(FRSQueue(), ^{
#ifdef FRS_HAS_SDK
    @try {
      float threshold = 0.67f;
      if (configJson.length > 0) {
        NSData *data = [configJson dataUsingEncoding:NSUTF8StringEncoding];
        NSDictionary *cfg = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
        if ([cfg isKindOfClass:[NSDictionary class]] && cfg[@"matchThreshold"] != nil) {
          threshold = [cfg[@"matchThreshold"] floatValue];
        }
      }
      [FaceSdkCompat stopWorker];
      [FaceSdkCompat startWorker:threshold];
      (void)weakSelf;
      resolve(@(0));
    } @catch (NSException *e) {
      reject(@"E_VIDEO_WORKER", e.reason, nil);
    }
#else
    FRS_MISSING_REJECT(resolve);
#endif
  });
}

RCT_EXPORT_METHOD(stopVideoWorker:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(FRSQueue(), ^{
#ifdef FRS_HAS_SDK
    [FaceSdkCompat stopWorker];
#endif
    self->videoFrameBusy = NO;
    resolve([NSNull null]);
  });
}

RCT_EXPORT_METHOD(syncVideoWorkerDatabase:(NSArray *)featuresB64
                  matchThreshold:(nonnull NSNumber *)matchThreshold
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(FRSQueue(), ^{
#ifdef FRS_HAS_SDK
    @try {
      NSMutableArray<NSData *> *features = [NSMutableArray array];
      for (id item in featuresB64) {
        if (![item isKindOfClass:[NSString class]]) continue;
        NSData *d = [[NSData alloc] initWithBase64EncodedString:(NSString *)item options:NSDataBase64DecodingIgnoreUnknownCharacters];
        if (d != nil) {
          [features addObject:d];
        }
      }
      int code = ({ [FaceSdkCompat syncWorker:features matchThreshold:matchThreshold.floatValue]; 0; });
      resolve(@(code));
    } @catch (NSException *e) {
      reject(@"E_SYNC_DB", e.reason, nil);
    }
#else
    FRS_MISSING_REJECT(resolve);
#endif
  });
}

RCT_EXPORT_METHOD(probeLiveImage:(NSString *)imageUri
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    @try {
      UIImage *raw = FRSImageFromUriOrBase64(imageUri);
      UIImage *baked = FRSBakeOrientation(raw);
      if (baked == nil) {
        reject(@"E_IMAGE", @"Could not decode image", nil);
        return;
      }
      CGFloat w = baked.size.width * baked.scale;
      CGFloat h = baked.size.height * baked.scale;
      resolve(@{ @"width": @(w), @"height": @(h) });
    } @catch (NSException *e) {
      reject(@"E_IMAGE", e.reason, nil);
    }
  });
}

RCT_EXPORT_METHOD(applyLiveFrame:(NSString *)imageUri
                  rotateDegrees:(nonnull NSNumber *)rotateDegrees
                  maxEdge:(nonnull NSNumber *)maxEdge
                  feedWorker:(BOOL)feedWorker
                  flipVertical:(BOOL)flipVertical
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
#ifdef FRS_HAS_SDK
  if (feedWorker && self->videoFrameBusy) {
    resolve(FRSLiveFrameResult(self->lastLiveImage, NO, nil));
    return;
  }
  if (feedWorker) {
    self->videoFrameBusy = YES;
  }
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    @try {
      UIImage *raw = FRSImageFromUriOrBase64(imageUri);
      UIImage *image = FRSApplyLiveTransform(
        raw, rotateDegrees.doubleValue, maxEdge.doubleValue, flipVertical);
      if (image == nil) {
        if (feedWorker) {
          self->videoFrameBusy = NO;
        }
        reject(@"E_IMAGE", @"Could not prepare live camera frame", nil);
        return;
      }
      self->lastLiveImage = image;
      self->lastLiveWidth = (NSInteger)(image.size.width * image.scale);
      self->lastLiveHeight = (NSInteger)(image.size.height * image.scale);
      if (feedWorker) {
        resolve(FRSLiveFrameResult(image, YES, nil));
        dispatch_async(FRSQueue(), ^{
          @try {
            (void)({ NSString *_ev = [FaceSdkCompat workerFrameJson:image]; if (_ev) { [self emitVideoWorkerEvent:_ev]; } 0; });
          } @catch (__unused NSException *e) {
          }
          self->videoFrameBusy = NO;
        });
      } else {
        NSString *path = FRSWriteTempJpeg(image, 0.9);
        if (path == nil) {
          reject(@"E_IMAGE", @"Could not prepare live camera frame", nil);
          return;
        }
        resolve(FRSLiveFrameResult(image, YES, path));
      }
    } @catch (NSException *e) {
      if (feedWorker) {
        self->videoFrameBusy = NO;
      }
      reject(@"E_FRAME", e.reason, nil);
    }
  });
#else
  resolve(FRSLiveFrameResult(nil, NO, imageUri));
#endif
}

/**
 * Detect on the frame applyLiveFrame already prepared and cached. The live loop used to write
 * that frame out as a JPEG and read it straight back just to detect on it.
 */
RCT_EXPORT_METHOD(detectLastLiveFrame:(NSString *)optionsJson
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
#ifdef FRS_HAS_SDK
  dispatch_async(FRSQueue(), ^{
    @try {
      UIImage *image = self->lastLiveImage;
      if (image == nil) {
        reject(@"E_FRAME", @"No live frame", nil);
        return;
      }
      NSDictionary *o = FRSParseObject(optionsJson);
      CFTimeInterval t0 = CACurrentMediaTime();
      // Same DetectOptions as Android: liveness:true must request the liveness
      // estimator without the old flag remapping (eyes vs liveness bits).
      NSString *json = [FaceSdkCompat detectJson:image param:FRSJsonString(@{
        @"check_liveness": @([o[@"liveness"] boolValue]),
        @"check_quality": @([o[@"quality"] boolValue]),
        @"check_pose": @([o[@"pose"] boolValue]),
        @"estimate_age_gender": @([o[@"ageGender"] boolValue]),
        @"check_eye_closeness": @([o[@"eyes"] boolValue]),
        @"check_emotion": @([o[@"expression"] boolValue]),
        @"check_landmarks": @([o[@"points"] boolValue]),
      })];
      NSArray *boxes = FRSBoxesFromDetectJSON(json) ?: @[];
      double detectMs = (CACurrentMediaTime() - t0) * 1000.0;
      NSDictionary *out = @{
        @"width": @(image.size.width * image.scale),
        @"height": @(image.size.height * image.scale),
        @"detectMs": @(detectMs),
        @"faces": boxes,
      };
      NSData *data = [NSJSONSerialization dataWithJSONObject:out options:0 error:nil];
      resolve(data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : @"{}");
    } @catch (NSException *e) {
      reject(@"E_DETECT", e.reason ?: @"detect failed", nil);
    }
  });
#else
  reject(@"E_SDK", @"facerecognitionsdk.framework is not linked", nil);
#endif
}

/** Write last ingested live frame to a temp JPEG (native keeps UIImage in memory). */
RCT_EXPORT_METHOD(exportLastLiveFrame:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
#ifdef FRS_HAS_SDK
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    @try {
      UIImage *image = self->lastLiveImage;
      if (image == nil) {
        reject(@"E_IMAGE", @"No live frame", nil);
        return;
      }
      NSString *path = FRSWriteTempJpeg(image, 0.92);
      if (path == nil) {
        reject(@"E_IMAGE", @"Could not export live frame", nil);
        return;
      }
      resolve(FRSLiveFrameResult(image, YES, path));
    } @catch (NSException *e) {
      reject(@"E_FRAME", e.reason, nil);
    }
  });
#else
  reject(@"E_SDK", @"SDK missing", nil);
#endif
}

RCT_EXPORT_METHOD(writeStatus:(NSString *)json
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  @try {
    NSArray *paths = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES);
    NSString *path = [paths[0] stringByAppendingPathComponent:@"facerecognition_status.json"];
    NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
    [data writeToFile:path atomically:YES];
    resolve([NSNull null]);
  } @catch (NSException *e) {
    reject(@"E_STATUS", e.reason, nil);
  }
}

// ---------------------------------------------------------------- demo API (detect options, 1:N, files)

static NSDictionary *FRSParseObject(NSString *json)
{
  if (json.length == 0) {
    return @{};
  }
  NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
  id obj = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
  return [obj isKindOfClass:[NSDictionary class]] ? (NSDictionary *)obj : @{};
}

static NSString *FRSResolvePath(NSString *path)
{
  NSString *p = path ?: @"";
  if ([p hasPrefix:@"file://"]) {
    p = [NSURL URLWithString:p].path ?: [p substringFromIndex:7];
  }
  if ([p hasPrefix:@"/"]) {
    return p;
  }
  return [FRSFilesDir() stringByAppendingPathComponent:p];
}

/** Upright pixels, long side <= maxSide (0 = keep size). Same pixels for detect and for saved crops. */
static UIImage *FRSLoadUpright(NSString *uri, CGFloat maxSide)
{
  UIImage *raw = FRSImageFromUriOrBase64(uri);
  if (raw == nil) {
    return nil;
  }
  return maxSide > 0 ? FRSScaledMaxEdge(raw, maxSide) : FRSFixOrientation(raw);
}

static UIImage *FRSCropRect(UIImage *image, CGRect rect)
{
  CGFloat iw = image.size.width * image.scale;
  CGFloat ih = image.size.height * image.scale;
  CGRect r = CGRectIntersection(CGRectIntegral(rect), CGRectMake(0, 0, iw, ih));
  if (CGRectIsNull(r) || r.size.width < 2 || r.size.height < 2) {
    return nil;
  }
  CGImageRef cg = CGImageCreateWithImageInRect(image.CGImage, r);
  if (cg == NULL) {
    return nil;
  }
  UIImage *out = [UIImage imageWithCGImage:cg scale:1.0 orientation:UIImageOrientationUp];
  CGImageRelease(cg);
  return out;
}

/** Face box + padding of the shorter box side (min 4 px), clamped. */
static UIImage *FRSCropPadded(UIImage *image, NSDictionary *box, CGFloat padding)
{
  CGFloat x1 = [box[@"x1"] doubleValue], y1 = [box[@"y1"] doubleValue];
  CGFloat x2 = [box[@"x2"] doubleValue], y2 = [box[@"y2"] doubleValue];
  CGFloat w = x2 - x1, h = y2 - y1;
  if (w <= 1 || h <= 1) {
    return nil;
  }
  CGFloat pad = MAX(4, floor(MIN(w, h) * padding));
  return FRSCropRect(image, CGRectMake(x1 - pad, y1 - pad, w + 2 * pad, h + 2 * pad));
}

/** Square centred on the face (Probe tile). */
static UIImage *FRSSquareAround(UIImage *image, NSDictionary *box, CGFloat scale)
{
  CGFloat iw = image.size.width * image.scale;
  CGFloat ih = image.size.height * image.scale;
  CGFloat x1 = [box[@"x1"] doubleValue], y1 = [box[@"y1"] doubleValue];
  CGFloat x2 = [box[@"x2"] doubleValue], y2 = [box[@"y2"] doubleValue];
  CGFloat side = MIN(round(MAX(x2 - x1, y2 - y1) * scale), MIN(iw, ih));
  if (side <= 1) {
    return image;
  }
  CGFloat left = MIN(MAX(0, (x1 + x2) / 2 - side / 2), iw - side);
  CGFloat top = MIN(MAX(0, (y1 + y2) / 2 - side / 2), ih - side);
  return FRSCropRect(image, CGRectMake(left, top, side, side)) ?: image;
}

#ifdef FRS_HAS_SDK
static FaceRecognitionDetectFlags FRSFlagsFromOptions(NSDictionary *o)
{
  FaceRecognitionDetectFlags flags = 0;
  if ([o[@"pose"] boolValue]) flags |= FaceRecognitionDetectPose;
  if ([o[@"points"] boolValue]) flags |= FaceRecognitionDetectLandmarks;
  if ([o[@"ageGender"] boolValue]) flags |= FaceRecognitionDetectAge | FaceRecognitionDetectGender;
  if ([o[@"expression"] boolValue]) flags |= FaceRecognitionDetectEmotion;
  if ([o[@"quality"] boolValue]) flags |= FaceRecognitionDetectQuality | FaceRecognitionDetectFaceQuality;
  if ([o[@"eyes"] boolValue]) flags |= FaceRecognitionDetectEyes;
  if ([o[@"liveness"] boolValue]) flags |= FaceRecognitionDetectLiveness | FaceRecognitionDetectLivenessAccurate;
  if (flags == 0) flags = FaceRecognitionDetectPose;
  return flags;
}
#endif

/** Prepared image -> upright JPEG in the temp dir (same pixels for every later call). */
RCT_EXPORT_METHOD(prepareImage:(NSString *)imageUri
                  maxSide:(nonnull NSNumber *)maxSide
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(FRSQueue(), ^{
    @try {
      UIImage *image = FRSLoadUpright(imageUri, maxSide.doubleValue);
      NSString *uri = FRSWriteTempJpeg(image, 0.95);
      if (image == nil || uri == nil) {
        reject(@"E_IMAGE", @"Could not decode image", nil);
        return;
      }
      resolve(@{ @"uri": uri, @"width": @(image.size.width * image.scale), @"height": @(image.size.height * image.scale) });
    } @catch (NSException *e) {
      reject(@"E_IMAGE", e.reason, nil);
    }
  });
}

/**
 * Detect with explicit options + optional per-face templates (same JSON contract as Android):
 * { width, height, detectMs, templateMs, faces: [...] }. smile / mouth_opened are null on iOS.
 */
RCT_EXPORT_METHOD(detectFaces:(NSString *)imageUri
                  optionsJson:(NSString *)optionsJson
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(FRSQueue(), ^{
#ifdef FRS_HAS_SDK
    @try {
      NSDictionary *o = FRSParseObject(optionsJson);
      CGFloat maxSide = o[@"maxSide"] != nil ? [o[@"maxSide"] doubleValue] : 1280.0;
      UIImage *image = FRSLoadUpright(imageUri, maxSide);
      if (image == nil) {
        reject(@"E_IMAGE", @"Could not decode image", nil);
        return;
      }
      CFTimeInterval t0 = CACurrentMediaTime();
      NSString *json = [FaceSdkCompat detectJson:image flags:FRSFlagsFromOptions(o)];
      NSMutableArray *boxes = [FRSBoxesFromDetectJSON(json) mutableCopy];
      double detectMs = (CACurrentMediaTime() - t0) * 1000.0;
      if ([o[@"sortBySize"] boolValue]) {
        [boxes sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
          double aa = ([a[@"x2"] doubleValue] - [a[@"x1"] doubleValue]) * ([a[@"y2"] doubleValue] - [a[@"y1"] doubleValue]);
          double bb = ([b[@"x2"] doubleValue] - [b[@"x1"] doubleValue]) * ([b[@"y2"] doubleValue] - [b[@"y1"] doubleValue]);
          return aa > bb ? NSOrderedAscending : (aa < bb ? NSOrderedDescending : NSOrderedSame);
        }];
      }
      NSInteger maxTemplates = [o[@"templates"] integerValue];
      BOOL eyes = [o[@"eyes"] boolValue];
      BOOL quality = [o[@"quality"] boolValue];
      double templateMs = 0;
      NSMutableArray *faces = [NSMutableArray array];
      for (NSUInteger i = 0; i < boxes.count; i++) {
        NSMutableDictionary *f = [boxes[i] mutableCopy];
        f[@"score"] = [NSNull null];
        f[@"poseComputed"] = @([o[@"pose"] boolValue]);
        f[@"quality"] = quality ? f[@"face_quality"] : [NSNull null];
        NSString *el = f[@"eyesLeftLabel"];
        NSString *er = f[@"eyesRightLabel"];
        if (eyes && (el.length > 0 || er.length > 0)) {
          double closed = MAX([f[@"left_eye_closed"] doubleValue], [f[@"right_eye_closed"] doubleValue]);
          f[@"eyes_open"] = @(1.0 - closed);
        } else {
          f[@"eyes_open"] = [NSNull null];
        }
        f[@"smile"] = [NSNull null];
        f[@"mouth_opened"] = [NSNull null];
        if ((NSInteger)i < maxTemplates) {
          CFTimeInterval ts = CACurrentMediaTime();
          // Extract from this exact detection on the same prepared image, without a crop/re-detect.
          NSString *b64 = [FaceSdkCompat templateBase64:image faceJson:FRSJsonString(f)];
          double ms = (CACurrentMediaTime() - ts) * 1000.0;
          templateMs += ms;
          f[@"templateMs"] = @(ms);
          NSData *bytes = b64.length ? [[NSData alloc] initWithBase64EncodedString:b64 options:NSDataBase64DecodingIgnoreUnknownCharacters] : nil;
          f[@"template"] = bytes.length ? b64 : [NSNull null];
          f[@"templateBytes"] = @(bytes.length);
        }
        [faces addObject:f];
      }
      NSDictionary *out = @{
        @"width": @(image.size.width * image.scale),
        @"height": @(image.size.height * image.scale),
        @"detectMs": @(detectMs),
        @"templateMs": @(templateMs),
        @"faces": faces,
      };
      NSData *data = [NSJSONSerialization dataWithJSONObject:out options:0 error:nil];
      resolve(data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : @"{}");
    } @catch (NSException *e) {
      reject(@"E_DETECT", e.reason, nil);
    }
#else
    FRS_MISSING_REJECT(resolve);
#endif
  });
}

RCT_EXPORT_METHOD(similarityMany:(NSString *)probeB64
                  candidates:(NSArray *)candidates
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(FRSQueue(), ^{
#ifdef FRS_HAS_SDK
    @try {
      NSData *probe = [[NSData alloc] initWithBase64EncodedString:probeB64 ?: @"" options:NSDataBase64DecodingIgnoreUnknownCharacters];
      NSMutableArray *out = [NSMutableArray arrayWithCapacity:candidates.count];
      for (id item in candidates) {
        if (![item isKindOfClass:[NSString class]] || [(NSString *)item length] == 0) {
          [out addObject:@(-1)];
          continue;
        }
        NSData *d = [[NSData alloc] initWithBase64EncodedString:(NSString *)item options:NSDataBase64DecodingIgnoreUnknownCharacters];
        float s = d ? [FaceRecognitionSDK similarityWithFeature1:probe feature2:d] : -1;
        [out addObject:@(isnan(s) ? -1 : s)];
      }
      resolve(out);
    } @catch (NSException *e) {
      reject(@"E_SIMILARITY", e.reason, nil);
    }
#else
    FRS_MISSING_REJECT(resolve);
#endif
  });
}

RCT_EXPORT_METHOD(writeFaceImage:(NSString *)imageUri
                  path:(NSString *)path
                  optionsJson:(NSString *)optionsJson
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(FRSQueue(), ^{
    @try {
      NSDictionary *o = FRSParseObject(optionsJson);
      CGFloat maxSide = o[@"maxSide"] != nil ? [o[@"maxSide"] doubleValue] : 1280.0;
      UIImage *image = FRSLoadUpright(imageUri, maxSide);
      if (image == nil) {
        reject(@"E_IMAGE", @"Could not decode image", nil);
        return;
      }
      NSDictionary *box = [o[@"box"] isKindOfClass:[NSDictionary class]] ? o[@"box"] : nil;
      NSString *mode = [o[@"mode"] isKindOfClass:[NSString class]] ? o[@"mode"] : (box ? @"padded" : @"full");
      UIImage *outImage = image;
      if (box && [mode isEqualToString:@"padded"]) {
        outImage = FRSCropPadded(image, box, o[@"padding"] ? [o[@"padding"] doubleValue] : 0.12) ?: image;
      } else if (box && [mode isEqualToString:@"square"]) {
        outImage = FRSSquareAround(image, box, o[@"scale"] ? [o[@"scale"] doubleValue] : 1.8);
      }
      NSString *file = FRSResolvePath(path);
      [[NSFileManager defaultManager] createDirectoryAtPath:[file stringByDeletingLastPathComponent]
                                withIntermediateDirectories:YES attributes:nil error:nil];
      CGFloat q = o[@"quality"] ? [o[@"quality"] doubleValue] / 100.0 : 0.92;
      NSData *data = UIImageJPEGRepresentation(outImage, q);
      if (data == nil || ![data writeToFile:file atomically:YES]) {
        reject(@"E_WRITE", @"Could not write image", nil);
        return;
      }
      resolve([@"file://" stringByAppendingString:file]);
    } @catch (NSException *e) {
      reject(@"E_WRITE", e.reason, nil);
    }
  });
}

RCT_EXPORT_METHOD(deleteFiles:(NSArray *)paths
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(FRSQueue(), ^{
    NSInteger n = 0;
    for (id p in paths) {
      if (![p isKindOfClass:[NSString class]] || [(NSString *)p length] == 0) continue;
      if ([[NSFileManager defaultManager] removeItemAtPath:FRSResolvePath(p) error:nil]) n++;
    }
    resolve(@(n));
  });
}

RCT_EXPORT_METHOD(deleteDirectory:(NSString *)path
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(FRSQueue(), ^{
    NSString *dir = FRSResolvePath(path);
    NSInteger n = 0;
    for (NSString *name in [[NSFileManager defaultManager] contentsOfDirectoryAtPath:dir error:nil] ?: @[]) {
      if ([[NSFileManager defaultManager] removeItemAtPath:[dir stringByAppendingPathComponent:name] error:nil]) n++;
    }
    resolve(@(n));
  });
}

RCT_EXPORT_METHOD(pickFolderImages:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(dispatch_get_main_queue(), ^{
    UIViewController *host = RCTPresentedViewController();
    if (host == nil) {
      reject(@"E_ACTIVITY", @"No view controller", nil);
      return;
    }
    FRSFolderPicker *picker = [FRSFolderPicker new];
    picker.resolve = resolve;
    gFolderPicker = picker;
    UIDocumentPickerViewController *vc =
        [[UIDocumentPickerViewController alloc] initForOpeningContentTypes:@[ UTTypeFolder ]];
    vc.delegate = picker;
    [host presentViewController:vc animated:YES completion:nil];
  });
}

@end
