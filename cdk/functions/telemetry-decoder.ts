// cdk/functions/telemetry-decoder.ts
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";

const TABLE_NAME = process.env.TABLE_NAME!;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * Event is the message from IoT Topic Rule. We selected:
 *   SELECT *, topic() AS mqttTopic, timestamp() AS iotTimestamp
 */
export const handler = async (event: any) => {
  try {
    // Try to discover the deviceId
    let deviceId: string | undefined = event?.deviceId;
    if (!deviceId && typeof event?.mqttTopic === "string") {
      // topic looks like: devices/<id>/telemetry
      const m = event.mqttTopic.match(/^devices\/([^/]+)\/telemetry$/);
      if (m) deviceId = m[1];
    }
    if (!deviceId) throw new Error("deviceId not present in payload");

    // Timestamp (ms since epoch) – prefer payload ts, then IoT timestamp, else now
    const tsMs =
      Number(event?.ts) ||
      Number(event?.iotTimestamp) ||
      Date.now();

    // TTL in seconds (1 year from now)
    const ttl = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;

    const item = {
      deviceId,
      ts: Number(tsMs),
      ttl,
      // Keep the full original payload for later use
      data: JSON.stringify(event),
    };

    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: item,
      })
    );

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err: any) {
    console.error("ingest error", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err?.message ?? "error" }),
    };
  }
};
