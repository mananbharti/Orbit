Pod::Spec.new do |s|
  s.name           = 'OrbitPinnedTransport'
  s.version        = '0.1.0'
  s.summary        = 'Certificate-pinned HTTPS and WSS for Orbit'
  s.homepage       = 'https://github.com/mananbharti/orbit'
  s.license        = 'MIT'
  s.author         = 'Orbit'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/mananbharti/orbit.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.{h,m,swift}'
end
