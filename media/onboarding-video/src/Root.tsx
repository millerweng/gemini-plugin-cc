import {Composition} from 'remotion';
import {OnboardingVideo} from './OnboardingVideo';
import {dimensions, durationInFrames, fps} from './script';

export const RemotionRoot = () => {
  return (
    <Composition
      id="GeminiPluginCcOnboarding"
      component={OnboardingVideo}
      durationInFrames={durationInFrames}
      fps={fps}
      width={dimensions.width}
      height={dimensions.height}
    />
  );
};
