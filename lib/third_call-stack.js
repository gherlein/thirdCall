"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ThirdCallStack = void 0;
//  “Copyright Amazon.com Inc. or its affiliates.” 
const cdk = require("@aws-cdk/core");
const s3 = require("@aws-cdk/aws-s3");
const iam = require("@aws-cdk/aws-iam");
const lambda = require("@aws-cdk/aws-lambda");
const custom = require("@aws-cdk/custom-resources");
const sqs = require("@aws-cdk/aws-sqs");
const ddb = require("@aws-cdk/aws-dynamodb");
class ThirdCallStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        const deadLetterQueue = new sqs.Queue(this, 'deadLetterQueue');
        // create a bucket for the recorded wave files and set the right policies
        const wavFiles = new s3.Bucket(this, 'wavFiles', {
            publicReadAccess: false,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true
        });
        const wavFileBucketPolicy = new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                's3:GetObject',
                's3:PutObject',
                's3:PutObjectAcl'
            ],
            resources: [
                wavFiles.bucketArn,
                `${wavFiles.bucketArn}/*`
            ],
            sid: 'SIPMediaApplicationRead',
        });
        wavFileBucketPolicy.addServicePrincipal('voiceconnector.chime.amazonaws.com');
        wavFiles.addToResourcePolicy(wavFileBucketPolicy);
        /*
            new s3deploy.BucketDeployment(this, 'WavDeploy', {
              sources: [s3deploy.Source.asset('./wav_files')],
              destinationBucket: wavFiles,
              contentType: 'audio/wav'
            });
        */
        const smaLambdaRole = new iam.Role(this, 'smaLambdaRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        });
        smaLambdaRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"));
        const pollyRole = new iam.Role(this, 'pollyRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        });
        const pollyPolicyDoc = new iam.PolicyDocument({
            statements: [
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    //actions: ["polly:StartSpeechSynthesisTask","polly:ListSpeechSynthesisTasks","polly:GetSpeechSynthesisTask"],
                    actions: ["polly:SynthesizeSpeech"],
                    resources: ["*"],
                }),
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: ["s3:PutObject", "s3:ListObject"],
                    resources: [`${wavFiles.bucketArn}/*`],
                }),
            ],
        });
        const pollyPollicy = new iam.Policy(this, 'pollyPollicy', {
            document: pollyPolicyDoc
        });
        smaLambdaRole.attachInlinePolicy(pollyPollicy);
        // create the lambda function that does the call
        const thirdCall = new lambda.Function(this, 'thirdCall', {
            code: lambda.Code.fromAsset("src", { exclude: ["README.md"] }),
            handler: 'thirdCall.handler',
            runtime: lambda.Runtime.NODEJS_14_X,
            environment: {
                WAVFILE_BUCKET: wavFiles.bucketName,
            },
            role: smaLambdaRole,
            timeout: cdk.Duration.seconds(60)
        });
        const chimeCreateRole = new iam.Role(this, 'createChimeLambdaRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            inlinePolicies: {
                ['chimePolicy']: new iam.PolicyDocument({
                    statements: [new iam.PolicyStatement({
                            resources: ['*'],
                            actions: ['chime:*',
                                'lambda:GetPolicy',
                                'lambda:AddPermission',
                                'cloudformation:DescribeStacks',
                                'cloudformation:DescribeStackEvents',
                                'cloudformation:DescribeStackResource',
                                'cloudformation:DescribeStackResources',]
                        })]
                })
            },
            managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")]
        });
        /*
            // create the lambda for CDK custom resource to deploy SMA, etc.
            const chimeProviderLamba = new lambda.Function(this, 'chimeProviderLamba', {
              code: lambda.Code.fromAsset("chime-cdk-support", { exclude: ["README.md"] }),
              handler: 'chime-cdk-support.on_event',
              runtime: lambda.Runtime.PYTHON_3_9,
              role: chimeCreateRole,
              timeout: cdk.Duration.seconds(60)
            });
        */
        // create the lambda for CDK custom resource to deploy SMA, etc.
        const chimeProviderLamba = new lambda.Function(this, 'chimeProviderLamba', {
            code: lambda.Code.fromAsset("../test", { exclude: ["README.md"] }),
            handler: 'index.handler',
            runtime: lambda.Runtime.NODEJS_14_X,
            role: chimeCreateRole,
            timeout: cdk.Duration.seconds(120),
        });
        const chimeProvider = new custom.Provider(this, 'chimeProvider', {
            onEventHandler: chimeProviderLamba,
        });
        // need type declarations
        // https://www.typescriptlang.org/docs/handbook/declaration-files/introduction.html
        const chimeProviderProperties = {
            lambdaArn: thirdCall.functionArn,
            region: this.region,
            smaName: this.stackName,
            sipRuleName: this.stackName,
            sipTriggerType: 'ToPhoneNumber',
            phoneNumberRequired: true,
            phoneAreaCode: '505',
            phoneState: '',
            phoneCountry: '',
            phoneNumberType: 'SipMediaApplicationDialIn',
            phoneNumberTollFreePrefix: '',
        };
        console.log(chimeProviderProperties);
        console.log(chimeProvider.serviceToken);
        const inboundSMA = new cdk.CustomResource(this, 'inboundSMA', {
            serviceToken: chimeProvider.serviceToken,
            properties: chimeProviderProperties,
        });
        // these are the attributes returned from the custom resource!
        const inboundPhoneNumber = inboundSMA.getAttString('phoneNumber');
        const smaID = inboundSMA.getAttString("smaID");
        const sipRuleID = inboundSMA.getAttString("sipRuleID");
        const phoneID = inboundSMA.getAttString("phoneID");
        // Write the Telephony Handling Data to the output
        new cdk.CfnOutput(this, 'region', { value: this.region });
        new cdk.CfnOutput(this, 'inboundPhoneNumber', { value: inboundPhoneNumber });
        new cdk.CfnOutput(this, 'lambdaLog', { value: thirdCall.logGroup.logGroupName });
        new cdk.CfnOutput(this, 'lambdaARN', { value: thirdCall.functionArn });
        new cdk.CfnOutput(this, 'chimeProviderLog', { value: chimeProviderLamba.logGroup.logGroupName });
        new cdk.CfnOutput(this, "smaID", { value: smaID });
        new cdk.CfnOutput(this, "phoneID", { value: phoneID });
        new cdk.CfnOutput(this, "sipRuleID", { value: sipRuleID });
        new cdk.CfnOutput(this, "sipRuleName", { value: chimeProviderProperties.sipRuleName });
        /*
            // Create AppSync and database
            const api = new appsync.GraphqlApi(this, 'Api', {
              name: 'cdk-notes-appsync-api',
              schema: appsync.Schema.fromAsset('graphql/schema.graphql'),
              authorizationConfig: {
                defaultAuthorization: {
                  authorizationType: appsync.AuthorizationType.API_KEY,
                  apiKeyConfig: {
                    expires: cdk.Expiration.after(cdk.Duration.days(365))
                  }
                },
              },
              xrayEnabled: true,
            });
        
        
            new cdk.CfnOutput(this, "GraphQLAPIURL", { value: api.graphqlUrl });
            new cdk.CfnOutput(this, "GraphQLAPIKey", { value: api.apiKey || '' });
            new cdk.CfnOutput(this, "StackRegion",  { value: this.region });
        
            
            const notesLambda = new lambda.Function(this, 'AppSyncNotesHandler', {
              runtime: lambda.Runtime.NODEJS_12_X,
              handler: 'main.handler',
              code: lambda.Code.fromAsset('lambda-fns'),
              memorySize: 1024
            });
            
            // set the new Lambda function as a data source for the AppSync API
            const lambdaDs = api.addLambdaDataSource('lambdaDatasource', notesLambda);
        
        
            // set the CallHandler function as the data source for AppSync API
            const lambdaDs = api.addLambdaDataSource('thirdCall', thirdCall);
        
        
            // create resolvers to match GraphQL operations in schema
            lambdaDs.createResolver({
              typeName: "Query",
              fieldName: "getNoteById"
            });
        
            lambdaDs.createResolver({
              typeName: "Query",
              fieldName: "listNotes"
            });
        
            lambdaDs.createResolver({
              typeName: "Mutation",
              fieldName: "createNote"
            });
        
            lambdaDs.createResolver({
              typeName: "Mutation",
              fieldName: "deleteNote"
            });
        
            lambdaDs.createResolver({
              typeName: "Mutation",
              fieldName: "updateNote"
            });
        */
        const callInfoTable = new ddb.Table(this, 'callInfo', {
            partitionKey: {
                name: 'phoneNumber',
                type: ddb.AttributeType.STRING
            },
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            billingMode: ddb.BillingMode.PAY_PER_REQUEST,
            stream: ddb.StreamViewType.NEW_IMAGE
        });
        // enable the Lambda function to access the DynamoDB table (using IAM)
        callInfoTable.grantFullAccess(thirdCall);
        // put the table name in the lambda environment
        thirdCall.addEnvironment('CALLINFO_TABLE_NAME', callInfoTable.tableName);
        new cdk.CfnOutput(this, 'thirdCallInfoTable', { value: callInfoTable.tableName });
    }
}
exports.ThirdCallStack = ThirdCallStack;
exports.thirdCallStack = ThirdCallStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGhpcmRfY2FsbC1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInRoaXJkX2NhbGwtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQUEsbURBQW1EO0FBQ25ELHFDQUFxQztBQUNyQyxzQ0FBdUM7QUFFdkMsd0NBQXdDO0FBQ3hDLDhDQUErQztBQUMvQyxvREFBb0Q7QUFDcEQsd0NBQXlDO0FBR3pDLDZDQUE2QztBQUs3QyxNQUFhLGNBQWUsU0FBUSxHQUFHLENBQUMsS0FBSztJQUMzQyxZQUFZLEtBQW9CLEVBQUUsRUFBVSxFQUFFLEtBQXNCO1FBQ2xFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLE1BQU0sZUFBZSxHQUFHLElBQUksR0FBRyxDQUFDLEtBQUssQ0FBQyxJQUFJLEVBQUUsaUJBQWlCLENBQUMsQ0FBQztRQUUvRCx5RUFBeUU7UUFDekUsTUFBTSxRQUFRLEdBQUcsSUFBSSxFQUFFLENBQUMsTUFBTSxDQUFDLElBQUksRUFBRSxVQUFVLEVBQUU7WUFDL0MsZ0JBQWdCLEVBQUUsS0FBSztZQUN2QixhQUFhLEVBQUUsR0FBRyxDQUFDLGFBQWEsQ0FBQyxPQUFPO1lBQ3hDLGlCQUFpQixFQUFFLElBQUk7U0FDeEIsQ0FBQyxDQUFDO1FBQ0gsTUFBTSxtQkFBbUIsR0FBRyxJQUFJLEdBQUcsQ0FBQyxlQUFlLENBQUM7WUFDbEQsTUFBTSxFQUFFLEdBQUcsQ0FBQyxNQUFNLENBQUMsS0FBSztZQUN4QixPQUFPLEVBQUU7Z0JBQ1AsY0FBYztnQkFDZCxjQUFjO2dCQUNkLGlCQUFpQjthQUNsQjtZQUNELFNBQVMsRUFBRTtnQkFDVCxRQUFRLENBQUMsU0FBUztnQkFDbEIsR0FBRyxRQUFRLENBQUMsU0FBUyxJQUFJO2FBQzFCO1lBQ0QsR0FBRyxFQUFFLHlCQUF5QjtTQUMvQixDQUFDLENBQUM7UUFDSCxtQkFBbUIsQ0FBQyxtQkFBbUIsQ0FBQyxvQ0FBb0MsQ0FBQyxD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QUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxvQkFBb0IsRUFBRSxFQUFFLEtBQUssRUFBRSxhQUFhLENBQUMsU0FBUyxFQUFFLENBQUMsQ0FBQztJQUNwRixDQUFDO0NBRUY7QUFwUEQsd0NBb1BDO0FBQ0QsT0FBTyxDQUFDLGNBQWMsR0FBRyxjQUFjLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvLyAg4oCcQ29weXJpZ2h0IEFtYXpvbi5jb20gSW5jLiBvciBpdHMgYWZmaWxpYXRlcy7igJ0gXG5pbXBvcnQgKiBhcyBjZGsgZnJvbSAnQGF3cy1jZGsvY29yZSc7XG5pbXBvcnQgczMgPSByZXF1aXJlKCdAYXdzLWNkay9hd3MtczMnKTtcbmltcG9ydCBzM2RlcGxveSA9IHJlcXVpcmUoJ0Bhd3MtY2RrL2F3cy1zMy1kZXBsb3ltZW50JylcbmltcG9ydCBpYW0gPSByZXF1aXJlKCdAYXdzLWNkay9hd3MtaWFtJylcbmltcG9ydCBsYW1iZGEgPSByZXF1aXJlKCdAYXdzLWNkay9hd3MtbGFtYmRhJyk7XG5pbXBvcnQgY3VzdG9tID0gcmVxdWlyZSgnQGF3cy1jZGsvY3VzdG9tLXJlc291cmNlcycpXG5pbXBvcnQgc3FzID0gcmVxdWlyZSgnQGF3cy1jZGsvYXdzLXNxcycpO1xuXG5pbXBvcnQgKiBhcyBhcHBzeW5jIGZyb20gJ0Bhd3MtY2RrL2F3cy1hcHBzeW5jJztcbmltcG9ydCAqIGFzIGRkYiBmcm9tICdAYXdzLWNkay9hd3MtZHluYW1vZGInO1xuaW1wb3J0IHsgRnJvbUNsb3VkRm9ybWF0aW9uUHJvcGVydHlPYmplY3QgfSBmcm9tICdAYXdzLWNkay9jb3JlL2xpYi9jZm4tcGFyc2UnO1xuaW1wb3J0IHsgQ2hpbWVDbGllbnQgfSBmcm9tICdAYXdzLXNkay9jbGllbnQtY2hpbWUnO1xuaW1wb3J0IHsgc3RyaW5naWZ5IH0gZnJvbSAncXVlcnlzdHJpbmcnO1xuXG5leHBvcnQgY2xhc3MgVGhpcmRDYWxsU3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICBjb25zdHJ1Y3RvcihzY29wZTogY2RrLkNvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM/OiBjZGsuU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgY29uc3QgZGVhZExldHRlclF1ZXVlID0gbmV3IHNxcy5RdWV1ZSh0aGlzLCAnZGVhZExldHRlclF1ZXVlJyk7XG5cbiAgICAvLyBjcmVhdGUgYSBidWNrZXQgZm9yIHRoZSByZWNvcmRlZCB3YXZlIGZpbGVzIGFuZCBzZXQgdGhlIHJpZ2h0IHBvbGljaWVzXG4gICAgY29uc3Qgd2F2RmlsZXMgPSBuZXcgczMuQnVja2V0KHRoaXMsICd3YXZGaWxlcycsIHtcbiAgICAgIHB1YmxpY1JlYWRBY2Nlc3M6IGZhbHNlLFxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICAgIGF1dG9EZWxldGVPYmplY3RzOiB0cnVlXG4gICAgfSk7XG4gICAgY29uc3Qgd2F2RmlsZUJ1Y2tldFBvbGljeSA9IG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgJ3MzOkdldE9iamVjdCcsXG4gICAgICAgICdzMzpQdXRPYmplY3QnLFxuICAgICAgICAnczM6UHV0T2JqZWN0QWNsJ1xuICAgICAgXSxcbiAgICAgIHJlc291cmNlczogW1xuICAgICAgICB3YXZGaWxlcy5idWNrZXRBcm4sXG4gICAgICAgIGAke3dhdkZpbGVzLmJ1Y2tldEFybn0vKmBcbiAgICAgIF0sXG4gICAgICBzaWQ6ICdTSVBNZWRpYUFwcGxpY2F0aW9uUmVhZCcsXG4gICAgfSk7XG4gICAgd2F2RmlsZUJ1Y2tldFBvbGljeS5hZGRTZXJ2aWNlUHJpbmNpcGFsKCd2b2ljZWNvbm5lY3Rvci5jaGltZS5hbWF6b25hd3MuY29tJyk7XG4gICAgd2F2RmlsZXMuYWRkVG9SZXNvdXJjZVBvbGljeSh3YXZGaWxlQnVja2V0UG9saWN5KTtcbiAgICAvKlxuICAgICAgICBuZXcgczNkZXBsb3kuQnVja2V0RGVwbG95bWVudCh0aGlzLCAnV2F2RGVwbG95Jywge1xuICAgICAgICAgIHNvdXJjZXM6IFtzM2RlcGxveS5Tb3VyY2UuYXNzZXQoJy4vd2F2X2ZpbGVzJyldLFxuICAgICAgICAgIGRlc3RpbmF0aW9uQnVja2V0OiB3YXZGaWxlcyxcbiAgICAgICAgICBjb250ZW50VHlwZTogJ2F1ZGlvL3dhdidcbiAgICAgICAgfSk7XG4gICAgKi9cbiAgICBjb25zdCBzbWFMYW1iZGFSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdzbWFMYW1iZGFSb2xlJywge1xuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2xhbWJkYS5hbWF6b25hd3MuY29tJyksXG4gICAgfSk7XG4gICAgc21hTGFtYmRhUm9sZS5hZGRNYW5hZ2VkUG9saWN5KGlhbS5NYW5hZ2VkUG9saWN5LmZyb21Bd3NNYW5hZ2VkUG9saWN5TmFtZShcInNlcnZpY2Utcm9sZS9BV1NMYW1iZGFCYXNpY0V4ZWN1dGlvblJvbGVcIikpO1xuXG4gICAgY29uc3QgcG9sbHlSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdwb2xseVJvbGUnLCB7XG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnbGFtYmRhLmFtYXpvbmF3cy5jb20nKSxcbiAgICB9KTtcblxuICAgIGNvbnN0IHBvbGx5UG9saWN5RG9jID0gbmV3IGlhbS5Qb2xpY3lEb2N1bWVudCh7XG4gICAgICBzdGF0ZW1lbnRzOiBbXG4gICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgICAgLy9hY3Rpb25zOiBbXCJwb2xseTpTdGFydFNwZWVjaFN5bnRoZXNpc1Rhc2tcIixcInBvbGx5Okxpc3RTcGVlY2hTeW50aGVzaXNUYXNrc1wiLFwicG9sbHk6R2V0U3BlZWNoU3ludGhlc2lzVGFza1wiXSxcbiAgICAgICAgICBhY3Rpb25zOiBbXCJwb2xseTpTeW50aGVzaXplU3BlZWNoXCJdLFxuICAgICAgICAgIHJlc291cmNlczogW1wiKlwiXSxcbiAgICAgICAgfSksXG4gICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgICAgYWN0aW9uczogW1wiczM6UHV0T2JqZWN0XCIsIFwiczM6TGlzdE9iamVjdFwiXSxcbiAgICAgICAgICByZXNvdXJjZXM6IFtgJHt3YXZGaWxlcy5idWNrZXRBcm59LypgXSxcbiAgICAgICAgfSksLypcbiAgICAgICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgICAgICAgICAgYWN0aW9uczogW1wic25zOlB1Ymxpc2hcIl0sXG4gICAgICAgICAgICAgICAgcmVzb3VyY2VzOiBbXCIqXCJdLFxuICAgICAgICAgICAgfSksKi9cbiAgICAgIF0sXG4gICAgfSk7XG4gICAgY29uc3QgcG9sbHlQb2xsaWN5ID0gbmV3IGlhbS5Qb2xpY3kodGhpcywgJ3BvbGx5UG9sbGljeScsIHtcbiAgICAgIGRvY3VtZW50OiBwb2xseVBvbGljeURvY1xuICAgIH0pO1xuICAgIHNtYUxhbWJkYVJvbGUuYXR0YWNoSW5saW5lUG9saWN5KHBvbGx5UG9sbGljeSk7XG5cbiAgICAvLyBjcmVhdGUgdGhlIGxhbWJkYSBmdW5jdGlvbiB0aGF0IGRvZXMgdGhlIGNhbGxcbiAgICBjb25zdCB0aGlyZENhbGwgPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICd0aGlyZENhbGwnLCB7XG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQoXCJzcmNcIiwgeyBleGNsdWRlOiBbXCJSRUFETUUubWRcIl0gfSksXG4gICAgICBoYW5kbGVyOiAndGhpcmRDYWxsLmhhbmRsZXInLFxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzE0X1gsXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBXQVZGSUxFX0JVQ0tFVDogd2F2RmlsZXMuYnVja2V0TmFtZSxcbiAgICAgIH0sXG4gICAgICByb2xlOiBzbWFMYW1iZGFSb2xlLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoNjApXG4gICAgfSk7XG4gICAgY29uc3QgY2hpbWVDcmVhdGVSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdjcmVhdGVDaGltZUxhbWJkYVJvbGUnLCB7XG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnbGFtYmRhLmFtYXpvbmF3cy5jb20nKSxcbiAgICAgIGlubGluZVBvbGljaWVzOiB7XG4gICAgICAgIFsnY2hpbWVQb2xpY3knXTogbmV3IGlhbS5Qb2xpY3lEb2N1bWVudCh7XG4gICAgICAgICAgc3RhdGVtZW50czogW25ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgICAgICAgICBhY3Rpb25zOiBbJ2NoaW1lOionLFxuICAgICAgICAgICAgICAnbGFtYmRhOkdldFBvbGljeScsXG4gICAgICAgICAgICAgICdsYW1iZGE6QWRkUGVybWlzc2lvbicsXG4gICAgICAgICAgICAgICdjbG91ZGZvcm1hdGlvbjpEZXNjcmliZVN0YWNrcycsXG4gICAgICAgICAgICAgICdjbG91ZGZvcm1hdGlvbjpEZXNjcmliZVN0YWNrRXZlbnRzJyxcbiAgICAgICAgICAgICAgJ2Nsb3VkZm9ybWF0aW9uOkRlc2NyaWJlU3RhY2tSZXNvdXJjZScsXG4gICAgICAgICAgICAgICdjbG91ZGZvcm1hdGlvbjpEZXNjcmliZVN0YWNrUmVzb3VyY2VzJyxdXG4gICAgICAgICAgfSldXG4gICAgICAgIH0pXG4gICAgICB9LFxuICAgICAgbWFuYWdlZFBvbGljaWVzOiBbaWFtLk1hbmFnZWRQb2xpY3kuZnJvbUF3c01hbmFnZWRQb2xpY3lOYW1lKFwic2VydmljZS1yb2xlL0FXU0xhbWJkYUJhc2ljRXhlY3V0aW9uUm9sZVwiKV1cbiAgICB9KTtcblxuICAgIC8qXG4gICAgICAgIC8vIGNyZWF0ZSB0aGUgbGFtYmRhIGZvciBDREsgY3VzdG9tIHJlc291cmNlIHRvIGRlcGxveSBTTUEsIGV0Yy5cbiAgICAgICAgY29uc3QgY2hpbWVQcm92aWRlckxhbWJhID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCAnY2hpbWVQcm92aWRlckxhbWJhJywge1xuICAgICAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldChcImNoaW1lLWNkay1zdXBwb3J0XCIsIHsgZXhjbHVkZTogW1wiUkVBRE1FLm1kXCJdIH0pLFxuICAgICAgICAgIGhhbmRsZXI6ICdjaGltZS1jZGstc3VwcG9ydC5vbl9ldmVudCcsXG4gICAgICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuUFlUSE9OXzNfOSxcbiAgICAgICAgICByb2xlOiBjaGltZUNyZWF0ZVJvbGUsXG4gICAgICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoNjApXG4gICAgICAgIH0pO1xuICAgICovXG5cbiAgICAvLyBjcmVhdGUgdGhlIGxhbWJkYSBmb3IgQ0RLIGN1c3RvbSByZXNvdXJjZSB0byBkZXBsb3kgU01BLCBldGMuXG4gICAgY29uc3QgY2hpbWVQcm92aWRlckxhbWJhID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCAnY2hpbWVQcm92aWRlckxhbWJhJywge1xuICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KFwiLi4vdGVzdFwiLCB7IGV4Y2x1ZGU6IFtcIlJFQURNRS5tZFwiXSB9KSxcbiAgICAgIGhhbmRsZXI6ICdpbmRleC5oYW5kbGVyJyxcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18xNF9YLFxuICAgICAgcm9sZTogY2hpbWVDcmVhdGVSb2xlLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMTIwKSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGNoaW1lUHJvdmlkZXIgPSBuZXcgY3VzdG9tLlByb3ZpZGVyKHRoaXMsICdjaGltZVByb3ZpZGVyJywge1xuICAgICAgb25FdmVudEhhbmRsZXI6IGNoaW1lUHJvdmlkZXJMYW1iYSxcbiAgICB9KTtcblxuICAgIC8vIG5lZWQgdHlwZSBkZWNsYXJhdGlvbnNcbiAgICAvLyBodHRwczovL3d3dy50eXBlc2NyaXB0bGFuZy5vcmcvZG9jcy9oYW5kYm9vay9kZWNsYXJhdGlvbi1maWxlcy9pbnRyb2R1Y3Rpb24uaHRtbFxuICAgIGNvbnN0IGNoaW1lUHJvdmlkZXJQcm9wZXJ0aWVzID0ge1xuICAgICAgbGFtYmRhQXJuOiB0aGlyZENhbGwuZnVuY3Rpb25Bcm4sXG4gICAgICByZWdpb246IHRoaXMucmVnaW9uLFxuICAgICAgc21hTmFtZTogdGhpcy5zdGFja05hbWUsXG4gICAgICBzaXBSdWxlTmFtZTogdGhpcy5zdGFja05hbWUsXG4gICAgICBzaXBUcmlnZ2VyVHlwZTogJ1RvUGhvbmVOdW1iZXInLFxuICAgICAgcGhvbmVOdW1iZXJSZXF1aXJlZDogdHJ1ZSxcbiAgICAgIHBob25lQXJlYUNvZGU6ICc1MDUnLFxuICAgICAgcGhvbmVTdGF0ZTogJycsXG4gICAgICBwaG9uZUNvdW50cnk6ICcnLFxuICAgICAgcGhvbmVOdW1iZXJUeXBlOiAnU2lwTWVkaWFBcHBsaWNhdGlvbkRpYWxJbicsIC8vIEJ1c2luZXNzQ2FsbGluZyB8IFZvaWNlQ29ubmVjdG9yIHwgU2lwTWVkaWFBcHBsaWNhdGlvbkRpYWxJblxuICAgICAgcGhvbmVOdW1iZXJUb2xsRnJlZVByZWZpeDogJycsXG4gICAgfVxuICAgIGNvbnNvbGUubG9nKGNoaW1lUHJvdmlkZXJQcm9wZXJ0aWVzKTtcbiAgICBjb25zb2xlLmxvZyhjaGltZVByb3ZpZGVyLnNlcnZpY2VUb2tlbik7XG5cbiAgICBjb25zdCBpbmJvdW5kU01BID0gbmV3IGNkay5DdXN0b21SZXNvdXJjZSh0aGlzLCAnaW5ib3VuZFNNQScsIHtcbiAgICAgIHNlcnZpY2VUb2tlbjogY2hpbWVQcm92aWRlci5zZXJ2aWNlVG9rZW4sXG4gICAgICBwcm9wZXJ0aWVzOiBjaGltZVByb3ZpZGVyUHJvcGVydGllcyxcbiAgICB9KTtcblxuICAgIC8vIHRoZXNlIGFyZSB0aGUgYXR0cmlidXRlcyByZXR1cm5lZCBmcm9tIHRoZSBjdXN0b20gcmVzb3VyY2UhXG4gICAgY29uc3QgaW5ib3VuZFBob25lTnVtYmVyID0gaW5ib3VuZFNNQS5nZXRBdHRTdHJpbmcoJ3Bob25lTnVtYmVyJyk7XG4gICAgY29uc3Qgc21hSUQgPSBpbmJvdW5kU01BLmdldEF0dFN0cmluZyhcInNtYUlEXCIpO1xuICAgIGNvbnN0IHNpcFJ1bGVJRCA9IGluYm91bmRTTUEuZ2V0QXR0U3RyaW5nKFwic2lwUnVsZUlEXCIpO1xuICAgIGNvbnN0IHBob25lSUQgPSBpbmJvdW5kU01BLmdldEF0dFN0cmluZyhcInBob25lSURcIik7XG5cbiAgICAvLyBXcml0ZSB0aGUgVGVsZXBob255IEhhbmRsaW5nIERhdGEgdG8gdGhlIG91dHB1dFxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdyZWdpb24nLCB7IHZhbHVlOiB0aGlzLnJlZ2lvbiB9KTtcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnaW5ib3VuZFBob25lTnVtYmVyJywgeyB2YWx1ZTogaW5ib3VuZFBob25lTnVtYmVyIH0pO1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdsYW1iZGFMb2cnLCB7IHZhbHVlOiB0aGlyZENhbGwubG9nR3JvdXAubG9nR3JvdXBOYW1lIH0pO1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdsYW1iZGFBUk4nLCB7IHZhbHVlOiB0aGlyZENhbGwuZnVuY3Rpb25Bcm4gfSk7XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ2NoaW1lUHJvdmlkZXJMb2cnLCB7IHZhbHVlOiBjaGltZVByb3ZpZGVyTGFtYmEubG9nR3JvdXAubG9nR3JvdXBOYW1lIH0pO1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsIFwic21hSURcIiwgeyB2YWx1ZTogc21hSUQgfSk7XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgXCJwaG9uZUlEXCIsIHsgdmFsdWU6IHBob25lSUQgfSk7XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgXCJzaXBSdWxlSURcIiwgeyB2YWx1ZTogc2lwUnVsZUlEIH0pO1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsIFwic2lwUnVsZU5hbWVcIiwgeyB2YWx1ZTogY2hpbWVQcm92aWRlclByb3BlcnRpZXMuc2lwUnVsZU5hbWUgfSk7XG5cbiAgICAvKlxuICAgICAgICAvLyBDcmVhdGUgQXBwU3luYyBhbmQgZGF0YWJhc2VcbiAgICAgICAgY29uc3QgYXBpID0gbmV3IGFwcHN5bmMuR3JhcGhxbEFwaSh0aGlzLCAnQXBpJywge1xuICAgICAgICAgIG5hbWU6ICdjZGstbm90ZXMtYXBwc3luYy1hcGknLFxuICAgICAgICAgIHNjaGVtYTogYXBwc3luYy5TY2hlbWEuZnJvbUFzc2V0KCdncmFwaHFsL3NjaGVtYS5ncmFwaHFsJyksXG4gICAgICAgICAgYXV0aG9yaXphdGlvbkNvbmZpZzoge1xuICAgICAgICAgICAgZGVmYXVsdEF1dGhvcml6YXRpb246IHtcbiAgICAgICAgICAgICAgYXV0aG9yaXphdGlvblR5cGU6IGFwcHN5bmMuQXV0aG9yaXphdGlvblR5cGUuQVBJX0tFWSxcbiAgICAgICAgICAgICAgYXBpS2V5Q29uZmlnOiB7XG4gICAgICAgICAgICAgICAgZXhwaXJlczogY2RrLkV4cGlyYXRpb24uYWZ0ZXIoY2RrLkR1cmF0aW9uLmRheXMoMzY1KSlcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICAgIHhyYXlFbmFibGVkOiB0cnVlLFxuICAgICAgICB9KTtcbiAgICBcbiAgICBcbiAgICAgICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgXCJHcmFwaFFMQVBJVVJMXCIsIHsgdmFsdWU6IGFwaS5ncmFwaHFsVXJsIH0pO1xuICAgICAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCBcIkdyYXBoUUxBUElLZXlcIiwgeyB2YWx1ZTogYXBpLmFwaUtleSB8fCAnJyB9KTtcbiAgICAgICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgXCJTdGFja1JlZ2lvblwiLCAgeyB2YWx1ZTogdGhpcy5yZWdpb24gfSk7XG4gICAgXG4gICAgICAgIFxuICAgICAgICBjb25zdCBub3Rlc0xhbWJkYSA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgJ0FwcFN5bmNOb3Rlc0hhbmRsZXInLCB7XG4gICAgICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzEyX1gsXG4gICAgICAgICAgaGFuZGxlcjogJ21haW4uaGFuZGxlcicsXG4gICAgICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KCdsYW1iZGEtZm5zJyksXG4gICAgICAgICAgbWVtb3J5U2l6ZTogMTAyNFxuICAgICAgICB9KTtcbiAgICAgICAgXG4gICAgICAgIC8vIHNldCB0aGUgbmV3IExhbWJkYSBmdW5jdGlvbiBhcyBhIGRhdGEgc291cmNlIGZvciB0aGUgQXBwU3luYyBBUElcbiAgICAgICAgY29uc3QgbGFtYmRhRHMgPSBhcGkuYWRkTGFtYmRhRGF0YVNvdXJjZSgnbGFtYmRhRGF0YXNvdXJjZScsIG5vdGVzTGFtYmRhKTtcbiAgICBcbiAgICBcbiAgICAgICAgLy8gc2V0IHRoZSBDYWxsSGFuZGxlciBmdW5jdGlvbiBhcyB0aGUgZGF0YSBzb3VyY2UgZm9yIEFwcFN5bmMgQVBJXG4gICAgICAgIGNvbnN0IGxhbWJkYURzID0gYXBpLmFkZExhbWJkYURhdGFTb3VyY2UoJ3RoaXJkQ2FsbCcsIHRoaXJkQ2FsbCk7XG4gICAgXG4gICAgXG4gICAgICAgIC8vIGNyZWF0ZSByZXNvbHZlcnMgdG8gbWF0Y2ggR3JhcGhRTCBvcGVyYXRpb25zIGluIHNjaGVtYVxuICAgICAgICBsYW1iZGFEcy5jcmVhdGVSZXNvbHZlcih7XG4gICAgICAgICAgdHlwZU5hbWU6IFwiUXVlcnlcIixcbiAgICAgICAgICBmaWVsZE5hbWU6IFwiZ2V0Tm90ZUJ5SWRcIlxuICAgICAgICB9KTtcbiAgICBcbiAgICAgICAgbGFtYmRhRHMuY3JlYXRlUmVzb2x2ZXIoe1xuICAgICAgICAgIHR5cGVOYW1lOiBcIlF1ZXJ5XCIsXG4gICAgICAgICAgZmllbGROYW1lOiBcImxpc3ROb3Rlc1wiXG4gICAgICAgIH0pO1xuICAgIFxuICAgICAgICBsYW1iZGFEcy5jcmVhdGVSZXNvbHZlcih7XG4gICAgICAgICAgdHlwZU5hbWU6IFwiTXV0YXRpb25cIixcbiAgICAgICAgICBmaWVsZE5hbWU6IFwiY3JlYXRlTm90ZVwiXG4gICAgICAgIH0pO1xuICAgIFxuICAgICAgICBsYW1iZGFEcy5jcmVhdGVSZXNvbHZlcih7XG4gICAgICAgICAgdHlwZU5hbWU6IFwiTXV0YXRpb25cIixcbiAgICAgICAgICBmaWVsZE5hbWU6IFwiZGVsZXRlTm90ZVwiXG4gICAgICAgIH0pO1xuICAgIFxuICAgICAgICBsYW1iZGFEcy5jcmVhdGVSZXNvbHZlcih7XG4gICAgICAgICAgdHlwZU5hbWU6IFwiTXV0YXRpb25cIixcbiAgICAgICAgICBmaWVsZE5hbWU6IFwidXBkYXRlTm90ZVwiXG4gICAgICAgIH0pO1xuICAgICovXG5cbiAgICBjb25zdCBjYWxsSW5mb1RhYmxlID0gbmV3IGRkYi5UYWJsZSh0aGlzLCAnY2FsbEluZm8nLCB7XG4gICAgICBwYXJ0aXRpb25LZXk6IHtcbiAgICAgICAgbmFtZTogJ3Bob25lTnVtYmVyJyxcbiAgICAgICAgdHlwZTogZGRiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HXG4gICAgICB9LFxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICAgIGJpbGxpbmdNb2RlOiBkZGIuQmlsbGluZ01vZGUuUEFZX1BFUl9SRVFVRVNULFxuICAgICAgc3RyZWFtOiBkZGIuU3RyZWFtVmlld1R5cGUuTkVXX0lNQUdFXG4gICAgfSk7XG5cbiAgICAvLyBlbmFibGUgdGhlIExhbWJkYSBmdW5jdGlvbiB0byBhY2Nlc3MgdGhlIER5bmFtb0RCIHRhYmxlICh1c2luZyBJQU0pXG4gICAgY2FsbEluZm9UYWJsZS5ncmFudEZ1bGxBY2Nlc3ModGhpcmRDYWxsKVxuICAgIC8vIHB1dCB0aGUgdGFibGUgbmFtZSBpbiB0aGUgbGFtYmRhIGVudmlyb25tZW50XG4gICAgdGhpcmRDYWxsLmFkZEVudmlyb25tZW50KCdDQUxMSU5GT19UQUJMRV9OQU1FJywgY2FsbEluZm9UYWJsZS50YWJsZU5hbWUpO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ3RoaXJkQ2FsbEluZm9UYWJsZScsIHsgdmFsdWU6IGNhbGxJbmZvVGFibGUudGFibGVOYW1lIH0pO1xuICB9XG5cbn1cbmV4cG9ydHMudGhpcmRDYWxsU3RhY2sgPSBUaGlyZENhbGxTdGFjaztcblxuIl19