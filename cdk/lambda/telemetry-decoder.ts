import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.TABLE_NAME!;

// Event arrives from IoT Rule with fields we SELECTed
// Example: { deviceId:'test-001', ts:1736860800000, tempC:22.4, battery:3.71, mqttTopic:'devices/...', iotTimestamp:... }
export const handler = async (event: any) => {
  console.log("event:", JSON.stringify(event));

  const deviceId = event.deviceId || "unknown";
  const ts = Number(event.ts) || Date.now();

  const item = {
    deviceId,
    ts,
    data: JSON.stringify(event),
    // 30 days TTL
    ttl: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
  };

  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: item,
    })
  );

  return { statusCode: 200 };
};
