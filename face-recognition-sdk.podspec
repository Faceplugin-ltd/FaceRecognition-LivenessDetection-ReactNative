require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))
folly_compiler_flags = '-DFOLLY_NO_CONFIG -DFOLLY_MOBILE=1 -DFOLLY_USE_LIBCPP=1 -Wno-comma -Wno-shorten-64-to-32'

Pod::Spec.new do |s|
  s.name         = "face-recognition-sdk"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]

  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/Faceplugin-inc/FaceRecognition-React-Native.git", :tag => "#{s.version}" }

  s.source_files = "ios/**/*.{h,m,mm}"

  frameworks = []
  %w[
    facerecognitionsdk.xcframework
    facerecognitionsdk.framework
    FacePluginSDK.xcframework
    FacePPlugin.framework
    FaceDetect.xcframework
  ].each do |name|
    path = File.join(__dir__, "ios/Frameworks", name)
    frameworks << "ios/Frameworks/#{name}" if File.directory?(path)
  end
  # The liveness plugin is the device slice inside FacePlugin.xcframework.
  # facerecognitionsdk links @rpath/FacePPlugin.framework; without this embed
  # the process dies as soon as the engine loads (just after the splash).
  plugin_slice = File.join(__dir__, "ios/Frameworks/FacePlugin.xcframework/ios-arm64/FacePPlugin.framework")
  if File.directory?(plugin_slice) && frameworks.none? { |p| p.include?("FacePPlugin") }
    frameworks << "ios/Frameworks/FacePlugin.xcframework/ios-arm64/FacePPlugin.framework"
  end
  frameworks.uniq! { |p| File.basename(p, ".*") }
  # Prefer xcframework over a duplicate .framework of the same name.
  frameworks.reject! do |p|
    p.end_with?(".framework") && frameworks.include?(p.sub(/\.framework\z/, ".xcframework"))
  end
  s.vendored_frameworks = frameworks unless frameworks.empty?

  if respond_to?(:install_modules_dependencies, true)
    install_modules_dependencies(s)
  else
    s.dependency "React-Core"

    if ENV['RCT_NEW_ARCH_ENABLED'] == '1' then
      s.compiler_flags = folly_compiler_flags + " -DRCT_NEW_ARCH_ENABLED=1"
      s.pod_target_xcconfig    = {
          "HEADER_SEARCH_PATHS" => "\"$(PODS_ROOT)/boost\"",
          "OTHER_CPLUSPLUSFLAGS" => "-DFOLLY_NO_CONFIG -DFOLLY_MOBILE=1 -DFOLLY_USE_LIBCPP=1",
          "CLANG_CXX_LANGUAGE_STANDARD" => "c++17"
      }
      s.dependency "React-Codegen"
      s.dependency "RCT-Folly"
      s.dependency "RCTRequired"
      s.dependency "RCTTypeSafety"
      s.dependency "ReactCommon/turbomodule/core"
    end
  end

  # Folder picker uses UTTypeFolder. ObjC does not autolink that framework.
  s.framework = 'UniformTypeIdentifiers'
  xc = s.attributes_hash['pod_target_xcconfig'] || {}
  flags = xc['OTHER_LDFLAGS'].to_s
  flags = '$(inherited)' if flags.empty?
  unless flags.include?('UniformTypeIdentifiers')
    xc['OTHER_LDFLAGS'] = "#{flags} -framework UniformTypeIdentifiers"
  end
  s.pod_target_xcconfig = xc
end
