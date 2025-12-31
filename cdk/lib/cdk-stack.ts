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

    // -------- Frontend (SPA) --------
    const siteBucket = new s3.Bucket(this, "FrontendBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const distribution = new cloudfront.Distribution(this, "FrontendCdn", {
      defaultBehavior: { origin: new origins.S3Origin(siteBucket) },
      defaultRootObject: "index.html",
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: "/index.html", ttl: cdk.Duration.minutes(0) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: "/index.html", ttl: cdk.Duration.minutes(0) },
      ],
    });

    new cdk.CfnOutput(this, "BucketName", { value: siteBucket.bucketName });
    new cdk.CfnOutput(this, "DistributionId", { value: distribution.distributionId });

    // -------- Telemetry storage --------
    const telemetryTable = new dynamodb.Table(this, "TelemetryTable", {
      partitionKey: { name: "deviceId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "ts", type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Commands queue for writes from the website
    const commandsTable = new dynamodb.Table(this, "CommandsTable", {
      partitionKey: { name: "deviceId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "ts", type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // -------- Lambda: IoT ingest (decoder) --------
    const decoderLogs = new logs.LogGroup(this, "TelemetryDecoderLogs", {
      retention: logs.RetentionDays.ONE_WEEK,
    });

    const telemetryDecoderFn = new nodejs.NodejsFunction(this, "TelemetryDecoderFn", {
      entry: path.resolve(__dirname, "../../functions/telemetry-decoder.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,      
      environment: {
       TABLE_NAME: telemetryTable.tableName,
        // one-time nudge so CDK can create its own Version       
      },
      logGroup: decoderLogs,
    });

    telemetryTable.grantWriteData(telemetryDecoderFn);

    // Use alias "prod" for the decoder
    const decoderProd = new lambda.Alias(this, "DecoderFnProd", {
      aliasName: "prod",
      version: telemetryDecoderFn.currentVersion,
    });

    // IoT Rule → Lambda (use alias ARN)
    const iotRule = new iot.CfnTopicRule(this, "TelemetryRule", {
      ruleName: "ingest_telemetry",
      topicRulePayload: {
        sql: "SELECT *, topic() as mqttTopic, timestamp() as iotTimestamp FROM 'devices/+/telemetry'",
        awsIotSqlVersion: "2016-03-23",
        ruleDisabled: false,
        actions: [{ lambda: { functionArn: decoderProd.functionArn } }],
      },
    });

    decoderProd.addPermission("AllowIotInvoke", {
      action: "lambda:InvokeFunction",
      principal: new iam.ServicePrincipal("iot.amazonaws.com"),
      sourceArn: iotRule.attrArn,
    });

    // -------- Lambda: HTTP API --------
    const apiLogs = new logs.LogGroup(this, "TelemetryApiLogs", {
      retention: logs.RetentionDays.ONE_WEEK,
    });

    const telemetryApiHandler = new nodejs.NodejsFunction(this, "TelemetryApiHandler", {
      entry: path.resolve(__dirname, "../../functions/telemetry-api.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,      
      environment: {
        TABLE_NAME: telemetryTable.tableName,
        ALLOW_ORIGIN: "https://app.iotcontrol.cloud",
        // one-time nudge so CDK can create its own Version        
      },
      logGroup: apiLogs,
    });

    telemetryTable.grantReadData(telemetryApiHandler);
    commandsTable.grantWriteData(telemetryApiHandler);

    // Alias "prod" for the API handler
    const apiProd = new lambda.Alias(this, "ApiFnProd", {
      aliasName: "prod",
      version: telemetryApiHandler.currentVersion,
    });

    // -------- HTTP API (v2) --------
    const telemetryApi = new apigwv2.HttpApi(this, "TelemetryApi", {
      apiName: "TelemetryApi",
      createDefaultStage: true,
      corsPreflight: {
        allowOrigins: ["https://app.iotcontrol.cloud", "http://localhost:5173"],
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.OPTIONS],
        allowHeaders: ["content-type"],
      },
    });

    // Use the ALIAS as the integration target
    const latestIntegration = new apigwv2i.HttpLambdaIntegration("LatestIntegration", apiProd);
    const seriesIntegration = new apigwv2i.HttpLambdaIntegration("SeriesIntegration", apiProd);
    const writeIntegration  = new apigwv2i.HttpLambdaIntegration("WriteIntegration", apiProd);
    const catalogIntegration = new apigwv2i.HttpLambdaIntegration("CatalogIntegration", apiProd);

    telemetryApi.addRoutes({ path: "/devices/{deviceId}/latest", methods: [apigwv2.HttpMethod.GET], integration: latestIntegration });
    telemetryApi.addRoutes({ path: "/devices/{deviceId}/series", methods: [apigwv2.HttpMethod.GET], integration: seriesIntegration });
    telemetryApi.addRoutes({ path: "/devices/{deviceId}/write",  methods: [apigwv2.HttpMethod.POST], integration: writeIntegration });
    telemetryApi.addRoutes({ path: "/catalog/wnr",               methods: [apigwv2.HttpMethod.GET],  integration: catalogIntegration });

    new cdk.CfnOutput(this, "ApiUrl", { value: telemetryApi.apiEndpoint });
  }
}
