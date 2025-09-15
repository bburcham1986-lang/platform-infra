// functions/telemetry-api.ts
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.TABLE_NAME!;

// Allow your app’s origin
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://app.iotcontrol.cloud",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "content-type,authorization",
};

export const handler = async (event: any) => {
  const method = event.requestContext?.http?.method ?? "GET";
  if (method === "OPTIONS") {
    // Preflight response
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  try {
    const p = event.pathParameters ?? {};
    const deviceId = p.deviceId;
    const action = p.action; // "latest" | "series"

    if (!deviceId) {
      return { statusCode: 400, headers: CORS_HEADERS, body: "Missing deviceId" };
    }

    if (action === "latest") {
      const resp = await ddb.send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "deviceId = :d",
        ExpressionAttributeValues: { ":d": deviceId },
        ScanIndexForward: false,
        Limit: 1,
      }));
      const item = resp.Items?.[0] ?? null;
      return {
        statusCode: 200,
        headers: { ...CORS_HEADERS, "content-type": "application/json" },
        body: JSON.stringify(item),
      };
    }

    if (action === "series") {
      const lim = Number(event.queryStringParameters?.limit ?? 20);
      const resp = await ddb.send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "deviceId = :d",
        ExpressionAttributeValues: { ":d": deviceId },
        ScanIndexForward: false,
        Limit: lim,
      }));
      return {
        statusCode: 200,
        headers: { ...CORS_HEADERS, "content-type": "application/json" },
        body: JSON.stringify(resp.Items ?? []),
      };
    }

    return { statusCode: 404, headers: CORS_HEADERS, body: "Not found" };
  } catch (err: any) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: err?.stack || String(err),
    };
  }
};
