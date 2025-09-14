// cdk/lib/cdk-stack.ts
import * as path from "path";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as iot from "aws-cdk-lib/aws-iot";
import * as logs from "aws-cdk-lib/aws-logs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";

import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2i from "aws-cdk-lib/aws-apigatewayv2-integrations";

export class CdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // -------------------------
    // Frontend: S3 + CloudFront
    // -------------------------
    // NOTE: keep bucket (no autoDelete custom resource -> avoids s3:GetBucketTagging error)
    const siteBucket = new s3.Bucket(this, "FrontendBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // keep bucket/data
      // autoDeleteObjects: false (default) — important!
    });

    const distribution = new cloudfront.Distribution(this, "FrontendCdn", {
      // Use modern origin class per deprecation notice
      defaultBehavior: { origin: new origins.S3BucketOrigin(siteBucket) },
      defaultRootObject: "index.html",
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: "/index.html", ttl: cdk.Duration.minutes(0) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: "/index.html", ttl: cdk.Duration.minutes(0) },
      ],
    });

    new cdk.CfnOutput(this, "BucketName", { value: siteBucket.bucketName });
    new cdk.CfnOutput(this, "DistributionId", { value: distribution.distributionId });

    // ------------------
    // DynamoDB Telemetry
    // ------------------
    const telemetryTable = new dynamodb.Table(this, "TelemetryTable", {
      partitionKey: { name: "deviceId", type: dynamodb.AttributeType.STRING },
      sortKey:      { name: "ts",       type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // --------------------
    // Lambda: IoT Ingestor
    // --------------------
    const telemetryDecoderFn = new nodejs.NodejsFunction(this, "TelemetryDecoderFn", {
      entry: path.join(__dirname, "../functions/telemetry-decoder.ts"), // cdk/functions/telemetry-decoder.ts
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      environment: { TABLE_NAME: telemetryTable.tableName },
      // (logRetention is deprecated; it's OK to leave it out)
      logRetention: logs.RetentionDays.ONE_WEEK,
    });
    telemetryTable.grantWriteData(telemetryDecoderFn);

    // Keep the SAME logical ID as your earlier rule to avoid duplicates
    const iotRule = new iot.CfnTopicRule(this, "TelemetryRule", {
      ruleName: "ingest_telemetry", // underscore is allowed; keep name stable
      topicRulePayload: {
        sql: "SELECT *, topic() as mqttTopic, timestamp() as iotTimestamp FROM 'devices/+/telemetry'",
        awsIotSqlVersion: "2016-03-23",
        ruleDisabled: false,
        actions: [{ lambda: { functionArn: telemetryDecoderFn.functionArn } }],
      },
    });

    telemetryDecoderFn.addPermission("AllowIotInvoke", {
      principal: new iam.ServicePrincipal("iot.amazonaws.com"),
      sourceArn: iotRule.attrArn,
    });

    // ------------------------
    // Lambda: Read API handler
    // ------------------------
    const telemetryApiHandler = new nodejs.NodejsFunction(this, "TelemetryApiHandler", {
      entry: path.join(__dirname, "../functions/telemetry-api.ts"), // cdk/functions/telemetry-api.ts
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      environment: { TABLE_NAME: telemetryTable.tableName },
      logRetention: logs.RetentionDays.ONE_WEEK,
    });
    telemetryTable.grantReadData(telemetryApiHandler);

    // ----------------------
    // HTTP API (v2) + CORS
    // ----------------------
    const telemetryApi = new apigwv2.HttpApi(this, "TelemetryApi", {
      apiName: "TelemetryApi",
      createDefaultStage: true,
      corsPreflight: {
        allowOrigins: [
          "https://app.iotcontrol.cloud",
          "http://localhost:5173",
        ],
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.OPTIONS],
        allowHeaders: ["content-type"],
      },
    });

    const latestIntegration = new apigwv2i.HttpLambdaIntegration("LatestIntegration", telemetryApiHandler);
    const seriesIntegration = new apigwv2i.HttpLambdaIntegration("SeriesIntegration", telemetryApiHandler);

    telemetryApi.addRoutes({
      path: "/devices/{deviceId}/latest",
      methods: [apigwv2.HttpMethod.GET],
      integration: latestIntegration,
    });

    telemetryApi.addRoutes({
      path: "/devices/{deviceId}/series",
      methods: [apigwv2.HttpMethod.GET],
      integration: seriesIntegration,
    });

    new cdk.CfnOutput(this, "ApiUrl", { value: telemetryApi.apiEndpoint });
  }
}
