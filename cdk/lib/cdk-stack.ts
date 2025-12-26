// cdk/lib/cdk-stack.ts
import * as path from "path";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

// Infra
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as iot from "aws-cdk-lib/aws-iot";
import * as logs from "aws-cdk-lib/aws-logs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";

// API v2 + Lambda integrations
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2i from "aws-cdk-lib/aws-apigatewayv2-integrations";

export class CdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // -------------
    // Frontend (SPA)
    // -------------
    // Keep the bucket (no auto-delete) to avoid s3:GetBucketTagging issues
    const siteBucket = new s3.Bucket(this, "FrontendBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // keep data on stack updates
    });

    // NOTE: S3Origin is marked deprecated in newer CDK, but widely available.
    // If your local version supports it, you can swap to `new origins.S3BucketOrigin(siteBucket)`.
    const distribution = new cloudfront.Distribution(this, "FrontendCdn", {
      defaultBehavior: {
        origin: new origins.S3Origin(siteBucket),
      },
      defaultRootObject: "index.html",
      errorResponses: [
        // Single-page app routing: serve index.html for 403/404
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: cdk.Duration.minutes(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: cdk.Duration.minutes(0),
        },
      ],
    });

    new cdk.CfnOutput(this, "BucketName", { value: siteBucket.bucketName });
    new cdk.CfnOutput(this, "DistributionId", {
      value: distribution.distributionId,
    });

    // -----------------
    // Telemetry storage
    // -----------------
    const telemetryTable = new dynamodb.Table(this, "TelemetryTable", {
      partitionKey: { name: "deviceId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "ts", type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // -------------------------
    // Lambda (ingest from IoT)
    // -------------------------
    // Create a LogGroup (preferred over the deprecated `logRetention` option)
    const decoderLogs = new logs.LogGroup(this, "TelemetryDecoderLogs", {
      retention: logs.RetentionDays.ONE_WEEK,
    });

    const telemetryDecoderFn = new nodejs.NodejsFunction(
      this,
      "TelemetryDecoderFn",
      {
        entry: path.resolve(
          __dirname,
          "../../functions/telemetry-decoder.ts"
        ),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_22_X,
        environment: {
          TABLE_NAME: telemetryTable.tableName,
        },
        logGroup: decoderLogs,
      }
    );
    telemetryTable.grantWriteData(telemetryDecoderFn);

    // Keep the same rule name so we don't create duplicates
    const iotRule = new iot.CfnTopicRule(this, "TelemetryRule", {
      ruleName: "ingest_telemetry",
      topicRulePayload: {
        sql: "SELECT *, topic() as mqttTopic, timestamp() as iotTimestamp FROM 'devices/+/telemetry'",
        awsIotSqlVersion: "2016-03-23",
        ruleDisabled: false,
        actions: [
          { lambda: { functionArn: telemetryDecoderFn.functionArn } },
        ],
      },
    });

    telemetryDecoderFn.addPermission("AllowIotInvoke", {
      action: "lambda:InvokeFunction",
      principal: new iam.ServicePrincipal("iot.amazonaws.com"),
      sourceArn: iotRule.attrArn,
    });

    // ----------------------
    // Lambda (read via HTTP)
    // ----------------------
    const apiLogs = new logs.LogGroup(this, "TelemetryApiLogs", {
      retention: logs.RetentionDays.ONE_WEEK,
    });

    const telemetryApiHandler = new nodejs.NodejsFunction(
      this,
      "TelemetryApiHandler",
      {
        entry: path.resolve(__dirname, "../../functions/telemetry-api.ts"),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_22_X,
        environment: {
          TABLE_NAME: telemetryTable.tableName,
          ALLOW_ORIGIN: "https://app.iotcontrol.cloud",
        },
        logGroup: apiLogs,
      }
    );
    telemetryTable.grantReadData(telemetryApiHandler);

    // -------------
    // HTTP API (v2)
    // -------------
    const telemetryApi = new apigwv2.HttpApi(this, "TelemetryApi", {
      apiName: "TelemetryApi",
      createDefaultStage: true,
      corsPreflight: {
        allowOrigins: [
          "https://app.iotcontrol.cloud",
          "http://localhost:5173",
        ],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ["content-type"],
      },
    });

    const latestIntegration = new apigwv2i.HttpLambdaIntegration(
      "LatestIntegration",
      telemetryApiHandler
    );
    const seriesIntegration = new apigwv2i.HttpLambdaIntegration(
      "SeriesIntegration",
      telemetryApiHandler
    );

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
