import { App } from "aws-cdk-lib";
import { CdkStack } from "../lib/cdk-stack";

const app = new App();
new CdkStack(app, "CdkStack", {
  env: { account: "309168475318", region: "us-east-1" },
});
