#import "FaceSdkCompat.h"

#if __has_include(<facerecognitionsdk/FaceRecognitionSDK.h>)
#import <facerecognitionsdk/FaceRecognitionSDK.h>
#define FRS_COMPAT_HAS_SDK 1
#endif

/**
 * The bridge's view of the engine on iOS.
 *
 * The SDK's API changed to match Android: detection runs through `FaceRecognitionImage`,
 * templates come from `templateFrom:face:`, and the VideoWorker, the crop, quality and
 * feature calls and the landmark mode were removed. This adapter keeps the JSON the
 * JavaScript, Dart and C# layers already parse, so nothing above the bridge changes, and
 * implements what the engine no longer provides.
 *
 * The selector names here were read from the Face-Recognition-LivenessDetection-iOS app's
 * Swift call sites, because the xcframework is not in this repository. They compile against
 * the real header; if one is spelled differently the compiler will say so.
 */

/** Smile at or above this reads as "Smiling", matching the Android app. */
static const float kSmileThreshold = 0.5f;

static BOOL gWorkerRunning = NO;
static float gWorkerThreshold = 0.8f;
static NSArray<NSData *> *gWorkerDb = nil;

static double FRSNum(float v) { return isnan(v) ? 0.0 : (double)v; }
static id FRSNumOrNull(float v) { return isnan(v) ? (id)[NSNull null] : @((double)v); }

static NSString *FRSJsonString(id object, NSString *fallback)
{
    if (object == nil) {
        return fallback;
    }
    NSError *error = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:&error];
    if (data == nil || error != nil) {
        return fallback;
    }
    return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: fallback;
}

#ifdef FRS_COMPAT_HAS_SDK

/** Everything the engine can report. */
static FaceRecognitionDetectOptions *FRSAllOptions(void)
{
    FaceRecognitionDetectOptions *o = [FaceRecognitionDetectOptions new];
    o.liveness = YES;
    o.quality = YES;
    o.pose = YES;
    o.ageGender = YES;
    o.eyes = YES;
    o.expression = YES;
    o.points = YES;
    return o;
}

/** The old flag bitmask. Anything out of range asks for everything. */
static FaceRecognitionDetectOptions *FRSOptionsFromFlags(unsigned long long flags)
{
    if (flags == 0 || flags >= 0xffffffffULL) {
        return FRSAllOptions();
    }
    FaceRecognitionDetectOptions *o = [FaceRecognitionDetectOptions new];
    o.pose = (flags & 0x01) != 0;
    o.points = (flags & 0x02) != 0;
    o.ageGender = ((flags & 0x04) != 0) || ((flags & 0x08) != 0);
    o.expression = (flags & 0x10) != 0;
    o.quality = ((flags & 0x20) != 0) || ((flags & 0x40) != 0);
    o.eyes = (flags & 0x80) != 0;
    o.liveness = ((flags & 0x100) != 0) || ((flags & 0x200) != 0);
    return o;
}

static FaceRecognitionDetectOptions *FRSOptionsFromParam(NSString *paramJson)
{
    if (paramJson.length == 0) {
        return FRSAllOptions();
    }
    NSData *data = [paramJson dataUsingEncoding:NSUTF8StringEncoding];
    id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if (![parsed isKindOfClass:[NSDictionary class]]) {
        return FRSAllOptions();
    }
    NSDictionary *p = parsed;
    if ([p[@"allAttributes"] boolValue]) {
        return FRSAllOptions();
    }
    FaceRecognitionDetectOptions *o = [FaceRecognitionDetectOptions new];
    o.liveness = [p[@"check_liveness"] boolValue];
    o.quality = [p[@"check_quality"] boolValue];
    o.pose = p[@"check_pose"] == nil ? YES : [p[@"check_pose"] boolValue];
    o.ageGender = [p[@"estimate_age_gender"] boolValue];
    o.eyes = [p[@"check_eye_closeness"] boolValue] || [p[@"check_face_occlusion"] boolValue];
    o.expression = [p[@"check_emotion"] boolValue];
    o.points = p[@"check_landmarks"] == nil ? YES : [p[@"check_landmarks"] boolValue];
    return o;
}

// Accessed only on the bridge's serial SDK queue. Do not retain decoded images.
static NSMutableDictionary<NSString *, FaceRecognitionFace *> *gDetectedFaces;
static NSMutableArray<NSString *> *gDetectionOrder;

static NSString *FRSRememberFace(FaceRecognitionFace *face)
{
    if (gDetectedFaces == nil) {
        gDetectedFaces = [NSMutableDictionary dictionary];
        gDetectionOrder = [NSMutableArray array];
    }
    NSString *key = [[NSUUID UUID] UUIDString];
    gDetectedFaces[key] = face;
    [gDetectionOrder addObject:key];
    while (gDetectionOrder.count > 256) {
        [gDetectedFaces removeObjectForKey:gDetectionOrder.firstObject];
        [gDetectionOrder removeObjectAtIndex:0];
    }
    return key;
}

/** The keys the hosts already read; a value the engine did not compute keeps its old neutral. */
static NSDictionary *FRSFaceDictionary(FaceRecognitionFace *f)
{
    CGRect b = f.bounds;
    NSMutableDictionary *o = [NSMutableDictionary dictionary];
    o[@"detectionId"] = FRSRememberFace(f);
    o[@"x1"] = @((int)CGRectGetMinX(b));
    o[@"y1"] = @((int)CGRectGetMinY(b));
    o[@"x2"] = @((int)CGRectGetMaxX(b));
    o[@"y2"] = @((int)CGRectGetMaxY(b));
    o[@"score"] = FRSNumOrNull(f.score);
    o[@"yaw"] = @(FRSNum(f.yaw));
    o[@"roll"] = @(FRSNum(f.roll));
    o[@"pitch"] = @(FRSNum(f.pitch));
    if (isnan(f.liveness)) {
        o[@"liveness"] = @(0.0);
        o[@"livenessLabel"] = @"";
    } else {
        o[@"liveness"] = @((double)f.liveness);
        o[@"livenessLabel"] = f.liveness > [FaceRecognitionSDK LIVENESS_THRESHOLD] ? @"Live" : @"Fake";
    }
    o[@"quality"] = FRSNumOrNull(f.quality);
    o[@"face_quality"] = isnan(f.quality) ? @(FRSNum(f.score)) : @((double)f.quality);
    o[@"face_luminance"] = @(0.0);
    if (isnan(f.eyesOpen)) {
        o[@"left_eye_closed"] = @(0.0);
        o[@"right_eye_closed"] = @(0.0);
    } else {
        double closed = 1.0 - f.eyesOpen;
        o[@"eyes_open"] = @((double)f.eyesOpen);
        o[@"left_eye_closed"] = @(closed);
        o[@"right_eye_closed"] = @(closed);
    }
    o[@"smile"] = FRSNumOrNull(f.smile);
    o[@"emotionLabel"] = isnan(f.smile) ? @"" : (f.smile >= kSmileThreshold ? @"Smiling" : @"Neutral");
    o[@"mouth_opened"] = FRSNumOrNull(f.mouthOpen);
    o[@"face_occlusion"] = @(0.0);
    o[@"age"] = @(f.age > 0 ? f.age : 0);
    o[@"genderLabel"] = f.genderLabel ?: @"";
    o[@"maskLabel"] = @"";
    o[@"qualityLabel"] = @"";
    // Open/Closed words depend on the app's eye threshold, so the engine does not label eyes.
    o[@"eyesLeftLabel"] = @"";
    o[@"eyesRightLabel"] = @"";
    o[@"glassesLabel"] = @"";
    o[@"sunglassesLabel"] = @"";
    o[@"occlusionLabel"] = @"";
    o[@"attributes"] = @{};
    NSMutableArray *landmarks = [NSMutableArray array];
    for (NSNumber *n in (f.points ?: @[])) {
        [landmarks addObject:@([n doubleValue])];
    }
    o[@"landmarkCount"] = @(landmarks.count / 2);
    o[@"landmarks"] = landmarks;
    return o;
}

static FaceRecognitionFace *FRSLargest(NSArray<FaceRecognitionFace *> *faces)
{
    FaceRecognitionFace *best = nil;
    CGFloat bestArea = -1;
    for (FaceRecognitionFace *f in faces) {
        CGFloat area = CGRectGetWidth(f.bounds) * CGRectGetHeight(f.bounds);
        if (area > bestArea) {
            bestArea = area;
            best = f;
        }
    }
    return best;
}

#endif

@implementation FaceSdkCompat

+ (NSString *)licenseStatusJson
{
#ifdef FRS_COMPAT_HAS_SDK
    FaceRecognitionLicense *lic = [FaceRecognitionSDK license];
    if (lic != nil) {
        return FRSJsonString(@{
            @"licensed": @(lic.licensed),
            @"level": @(lic.level),
            @"levelName": lic.levelName ?: @"None",
            @"recognition": @(lic.recognition),
            @"liveness": @(lic.liveness),
            @"label": lic.label ?: @"",
        }, @"");
    }
#endif
    return @"{\"licensed\":false,\"level\":-1,\"levelName\":\"None\",\"recognition\":false,"
            "\"liveness\":false,\"label\":\"Not licensed\"}";
}

+ (NSString *)detectJson:(UIImage *)image flags:(unsigned long long)flags
{
#ifdef FRS_COMPAT_HAS_SDK
    FaceRecognitionImage *frame = [FaceRecognitionImage fromUIImage:image];
    if (frame == nil) {
        return @"[]";
    }
    NSMutableArray *out = [NSMutableArray array];
    @try {
        for (FaceRecognitionFace *f in [frame detect:FRSOptionsFromFlags(flags)] ?: @[]) {
            [out addObject:FRSFaceDictionary(f)];
        }
    } @finally {
        [frame close];
    }
    return FRSJsonString(out, @"[]");
#else
    return @"[]";
#endif
}

+ (NSString *)detectJson:(UIImage *)image param:(NSString *)paramJson
{
#ifdef FRS_COMPAT_HAS_SDK
    FaceRecognitionImage *frame = [FaceRecognitionImage fromUIImage:image];
    if (frame == nil) {
        return @"[]";
    }
    NSMutableArray *out = [NSMutableArray array];
    @try {
        for (FaceRecognitionFace *f in [frame detect:FRSOptionsFromParam(paramJson)] ?: @[]) {
            [out addObject:FRSFaceDictionary(f)];
        }
    } @finally {
        [frame close];
    }
    return FRSJsonString(out, @"[]");
#else
    return @"[]";
#endif
}

+ (void)clearDetectedFaces
{
#ifdef FRS_COMPAT_HAS_SDK
    [gDetectedFaces removeAllObjects];
    [gDetectionOrder removeAllObjects];
#endif
}

+ (NSString *)templateBase64:(UIImage *)image faceJson:(NSString *)faceJson
{
#ifdef FRS_COMPAT_HAS_SDK
    NSData *jsonData = [faceJson dataUsingEncoding:NSUTF8StringEncoding];
    id parsed = jsonData ? [NSJSONSerialization JSONObjectWithData:jsonData options:0 error:nil] : nil;
    id key = [parsed isKindOfClass:[NSDictionary class]] ? parsed[@"detectionId"] : nil;
    FaceRecognitionFace *face = [key isKindOfClass:[NSString class]] ? gDetectedFaces[key] : nil;
    if (face == nil) {
        [NSException raise:NSInvalidArgumentException format:@"Missing or expired detection result"];
    }
    NSData *bytes = [FaceRecognitionSDK templateFromImage:image face:face];
    return bytes.length > 0 ? [bytes base64EncodedStringWithOptions:0] : @"";
#else
    return @"";
#endif
}

+ (NSString *)templateBase64:(UIImage *)image
{
#ifdef FRS_COMPAT_HAS_SDK
    FaceRecognitionImage *frame = [FaceRecognitionImage fromUIImage:image];
    if (frame == nil) {
        return @"";
    }
    FaceRecognitionFace *face = nil;
    @try {
        face = FRSLargest([frame detect:FRSAllOptions()] ?: @[]);
    } @finally {
        [frame close];
    }
    if (face == nil) {
        return @"";
    }
    NSData *data = [FaceRecognitionSDK templateFromImage:image face:face];
    return data.length > 0 ? [data base64EncodedStringWithOptions:0] : @"";
#else
    return @"";
#endif
}

+ (NSString *)extractFeatureJson:(UIImage *)image
{
    NSString *feature = [self templateBase64:image];
    return feature.length > 0 ? FRSJsonString(@{@"feature": feature}, @"{}") : @"{}";
}

+ (NSString *)qualityJson:(UIImage *)image
{
#ifdef FRS_COMPAT_HAS_SDK
    FaceRecognitionImage *frame = [FaceRecognitionImage fromUIImage:image];
    if (frame == nil) {
        return @"{}";
    }
    FaceRecognitionFace *face = nil;
    @try {
        face = FRSLargest([frame detect:FRSAllOptions()] ?: @[]);
    } @finally {
        [frame close];
    }
    if (face == nil) {
        return @"{}";
    }
    return FRSJsonString(@{@"quality": FRSNumOrNull(face.quality),
                           @"score": FRSNumOrNull(face.score)}, @"{}");
#else
    return @"{}";
#endif
}

// ---------------------------------------------------------------- VideoWorker, emulated

+ (void)startWorker:(float)matchThreshold
{
    gWorkerThreshold = matchThreshold;
    // A new session starts without a gallery: the capture guide never matches frames.
    gWorkerDb = @[];
    gWorkerRunning = YES;
}

+ (void)stopWorker
{
    gWorkerRunning = NO;
    gWorkerDb = @[];
}

+ (void)syncWorker:(NSArray<NSData *> *)features matchThreshold:(float)matchThreshold
{
    gWorkerDb = features ?: @[];
    gWorkerThreshold = matchThreshold;
}

+ (BOOL)workerRunning
{
    return gWorkerRunning;
}

/** At most one gallery scan every 400 ms while tracking. */
static BOOL FRSDueForMatch(void)
{
    static CFTimeInterval last = 0;
    CFTimeInterval now = CACurrentMediaTime();
    if (now - last < 0.4) {
        return NO;
    }
    last = now;
    return YES;
}

+ (nullable NSString *)workerFrameJson:(UIImage *)frameImage
{
    if (!gWorkerRunning) {
        return nil;
    }
#ifdef FRS_COMPAT_HAS_SDK
    FaceRecognitionImage *frame = [FaceRecognitionImage fromUIImage:frameImage];
    if (frame == nil) {
        return nil;
    }
    NSMutableArray *tracked = [NSMutableArray array];
    @try {
        // What the native capture guide asks for: a box, the pose and the landmarks it
        // draws. Eye openness is an estimator per frame and the gate does not read it.
        FaceRecognitionDetectOptions *options = [FaceRecognitionDetectOptions new];
        options.pose = YES;
        options.points = YES;
        NSArray<FaceRecognitionFace *> *faces = [frame detect:options] ?: @[];
        NSArray<NSData *> *db = gWorkerDb;

        for (NSUInteger index = 0; index < faces.count; index++) {
            FaceRecognitionFace *f = faces[index];
            CGRect b = f.bounds;
            NSMutableArray *points = [NSMutableArray array];
            NSArray<NSNumber *> *raw = f.points ?: @[];
            for (NSUInteger i = 0; i + 1 < raw.count; i += 2) {
                [points addObject:@{@"x": @([raw[i] doubleValue]), @"y": @([raw[i + 1] doubleValue])}];
            }
            NSMutableDictionary *o = [@{
                @"track_id": @(index),
                @"faceRegion": @{@"x": @((int)CGRectGetMinX(b)), @"y": @((int)CGRectGetMinY(b)),
                                 @"width": @((int)CGRectGetWidth(b)), @"height": @((int)CGRectGetHeight(b))},
                @"facePose": @{@"yaw": @(FRSNum(f.yaw)), @"pitch": @(FRSNum(f.pitch)),
                               @"roll": @(FRSNum(f.roll))},
                @"facePoints": points,
                @"weak": @(NO),
            } mutableCopy];
            if (!isnan(f.eyesOpen)) {
                o[@"eyes_open"] = @((double)f.eyesOpen);
            }

            // A template plus a scan of the whole gallery is far too much to do on every
            // frame; the real VideoWorker matched on its own cadence.
            if (index == 0 && db.count > 0 && FRSDueForMatch()) {
                NSData *feature = [FaceRecognitionSDK templateFromImage:frameImage face:f];
                if (feature.length > 0) {
                    NSInteger bestIndex = -1;
                    float best = -1;
                    for (NSUInteger candidate = 0; candidate < db.count; candidate++) {
                        float score = [FaceRecognitionSDK similarityWithFeature1:feature
                                                                        feature2:db[candidate]];
                        if (!isnan(score) && score > best) {
                            best = score;
                            bestIndex = (NSInteger)candidate;
                        }
                    }
                    if (bestIndex >= 0) {
                        o[@"match"] = @{@"matched": @(best >= gWorkerThreshold),
                                        @"person_index": @(bestIndex),
                                        @"score": @((double)best)};
                    }
                }
            }
            [tracked addObject:o];
        }
    } @finally {
        [frame close];
    }

    // `event` is the discriminator every host parser checks first, and the frame size is what
    // the capture guide measures its ROI against. See the Kotlin adapter for the full note.
    return FRSJsonString(@{@"event": @"tracking",
                           @"frame_width": @((int)llround(frameImage.size.width * frameImage.scale)),
                           @"frame_height": @((int)llround(frameImage.size.height * frameImage.scale)),
                           @"faces": tracked}, nil);
#else
    return nil;
#endif
}

@end
