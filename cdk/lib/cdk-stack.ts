import { Stack, StackProps, RemovalPolicy, CfnOutput, Duration } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as path from "path";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodeLambda from "aws-cdk-lib/aws-lambda-nodejs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as iot from "aws-cdk-lib/aws-iot";

export class CdkStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // --- Existing frontend (keep as-is) ---
    const siteBucket = new s3.Bucket(this, "FrontendBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: false,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const distribution = new cloudfront.Distribution(this, "FrontendCdn", {
      defaultBehavior: { origin: new origins.S3Origin(siteBucket) },
      defaultRootObject: "index.html",
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: "/index.html", ttl: Duration.seconds(0) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: "/index.html", ttl: Duration.seconds(0) },
      ],
    });

    new CfnOutput(this, "BucketName", { value: siteBucket.bucketName });
    new CfnOutput(this, "DistributionId", { value: distribution.distributionId });

    // --- NEW: Telemetry storage (DynamoDB) ---
    const telemetryTable = new dynamodb.Table(this, "TelemetryTable", {
      tableName: "telemetry",                               // fixed name for simplicity
      partitionKey: { name: "deviceId", type: dynamodb.AttributeType.STRING },
      sortKey:      { name: "ts",       type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",                           // optional TTL
      removalPolicy: RemovalPolicy.RETAIN,                  // keep data if stack is deleted (change to DESTROY for dev)
    });

    // --- NEW: Lambda decoder (Node.js) ---
    const decoderFn = new nodeLambda.NodejsFunction(this, "TelemetryDecoderFn", {
      entry: path.join(__dirname, "../lambda/telemetry-decoder.ts"),
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 256,
      timeout: Duration.seconds(10),
      environment: {
        TABLE_NAME: telemetryTable.tableName,
      },
    });
    telemetryTable.grantWriteData(decoderFn);

    // Allow IoT Core to invoke this Lambda
    decoderFn.addPermission("AllowIotInvoke", {
      principal: new iam.ServicePrincipal("iot.amazonaws.com"),
      action: "lambda:InvokeFunction",
    });

    // --- NEW: IoT Rule -> Lambda on devices/+/telemetry ---
    new iot.CfnTopicRule(this, "TelemetryRule", {
      topicRulePayload: {
        ruleDisabled: false,
        awsIotSqlVersion: "2016-03-23",
        // Include topic and timestamp in the event sent to Lambda
        sql: "SELECT *, topic() AS mqttTopic, timestamp() AS iotTimestamp FROM 'devices/+/telemetry'",
        actions: [{ lambda: { functionArn: decoderFn.functionArn } }],
      },
    });

    new CfnOutput(this, "TelemetryTableName", { value: telemetryTable.tableName });
  }
}
