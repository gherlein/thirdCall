import { expect as expectCDK, matchTemplate, MatchStyle } from '@aws-cdk/assert';
import * as cdk from '@aws-cdk/core';
import * as ThirdCall from '../lib/third_call-stack';

test('Empty Stack', () => {
    const app = new cdk.App();
    // WHEN
    const stack = new ThirdCall.ThirdCallStack(app, 'MyTestStack');
    // THEN
    expectCDK(stack).to(matchTemplate({
      "Resources": {}
    }, MatchStyle.EXACT))
});
