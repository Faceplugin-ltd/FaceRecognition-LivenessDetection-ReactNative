#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

#ifndef FRS_COMPAT_DETECT_FLAGS
#define FRS_COMPAT_DETECT_FLAGS 1
/** Legacy flag bits FaceSdkCompat maps onto FaceRecognitionDetectOptions. */
typedef NS_OPTIONS(NSUInteger, FaceRecognitionDetectFlags) {
    FaceRecognitionDetectPose = 1 << 0,
    FaceRecognitionDetectLandmarks = 1 << 1,
    FaceRecognitionDetectAge = 1 << 2,
    FaceRecognitionDetectGender = 1 << 3,
    FaceRecognitionDetectEmotion = 1 << 4,
    FaceRecognitionDetectMask = 1 << 5,
    FaceRecognitionDetectQuality = 1 << 6,
    FaceRecognitionDetectFaceQuality = 1 << 7,
    FaceRecognitionDetectEyes = 1 << 8,
    FaceRecognitionDetectLiveness = 1 << 9,
    FaceRecognitionDetectGlasses = 1 << 11,
    FaceRecognitionDetectLivenessAccurate = 1 << 16,
    FaceRecognitionDetectAll = NSUIntegerMax,
};
#endif


/**
 * The bridge's view of the engine on iOS, keeping the JSON the hosts already parse while the
 * SDK's own API moved to `FaceRecognitionImage` / `templateFrom:face:`. It also implements the
 * VideoWorker, crop, quality and feature calls the engine no longer provides.
 *
 * Every call must already hold the engine's turn — the engine is not re-entrant.
 */
@interface FaceSdkCompat : NSObject

+ (NSString *)licenseStatusJson;

/** Faces as a JSON array, for the legacy numeric flags. */
+ (NSString *)detectJson:(UIImage *)image flags:(unsigned long long)flags;

/** Faces as a JSON array, for a `param` JSON. */
+ (NSString *)detectJson:(UIImage *)image param:(nullable NSString *)paramJson;

/** The strongest face's template as base64, or an empty string. */
+ (NSString *)templateBase64:(UIImage *)image;

/** Reuse a face returned by detection on this same image; never detect again.
 * Handles are session-local and bounded to the most recent 256 returned faces.
 */
+ (NSString *)templateBase64:(UIImage *)image faceJson:(NSString *)faceJson;
+ (void)clearDetectedFaces;

/** The strongest face's template as `{"feature":"<base64>"}`. */
+ (NSString *)extractFeatureJson:(UIImage *)image;

/** Quality for the strongest face. */
+ (NSString *)qualityJson:(UIImage *)image;

// VideoWorker, emulated on top of per-frame detection.
+ (void)startWorker:(float)matchThreshold;
+ (void)stopWorker;
+ (void)syncWorker:(NSArray<NSData *> *)features matchThreshold:(float)matchThreshold;
+ (BOOL)workerRunning;

/** One tracking event for a frame, or nil when no session is running. */
+ (nullable NSString *)workerFrameJson:(UIImage *)frameImage;

@end

NS_ASSUME_NONNULL_END
