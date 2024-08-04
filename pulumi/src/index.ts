import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as eks from "@pulumi/eks";
import { createHubRole } from "./iam.js"
import { createSpokeRole } from "./iam.js"
import { GitOpsClusterConfig } from "./github.js"
import { createVeleroResources } from "./components.js"

const callerIdentity = aws.getCallerIdentity({});
const awsAccountId = await callerIdentity.then(identity => identity.accountId);

const region = aws.getRegion();
const awsRegion = await region.then(r => r.name);

const stackName = pulumi.getStack()
const config = new pulumi.Config()

let roleMappings: eks.RoleMapping[] = []

const clusterComponents: any = config.requireObject("clusterComponents")

export const outputs: {[key: string]: any} = {
  "stackName": stackName,
  "addons_repo_url": `https://github.com/${config.require("githubOrg")}/${config.require("githubRepo")}`,
  "addons_repo_revision": config.require("githubRevision"),
  "aws_region": awsRegion,
  "aws_account_id": awsAccountId,
  "velero_namespace": "velero",
  "velero_service_account": "velero",
  "velero_backup_s3_bucket_prefix": "backups"
}

// VPC Config
const vpc = new awsx.ec2.Vpc(stackName, {
  cidrBlock: config.require("cidrBlock"),
  numberOfAvailabilityZones: 3,
  enableDnsHostnames: true,
  enableDnsSupport: true,
  natGateways: {
    strategy: awsx.ec2.NatGatewayStrategy.Single,
  },
  subnetSpecs: [
    {
      type: awsx.ec2.SubnetType.Private,
      tags: {
        "karpenter.sh/discovery": `${stackName}-cluster`,
        [`kubernetes.io/cluster/${stackName}-cluster`]: "owned",
        "kubernetes.io/role/internal-elb": "1",
      },
    },
    {
      type: awsx.ec2.SubnetType.Isolated,
      name: "tgw-attachment-subnet",
      cidrMask: 27,
    },
    {
      type: awsx.ec2.SubnetType.Public,
      tags: {
        [`kubernetes.io/cluster/${stackName}-cluster`]: "owned",
        "kubernetes.io/role/elb": "1",
      },
    },
  ]
})

// If we are creating a spoke cluster we need to create argoRole first, ensure it
// gets added to auth mapping for the cluster with the correct permissions
if (config.require("clusterType") === "spoke") {
  const argoRole = createSpokeRole(config)
  roleMappings.push({
    roleArn: argoRole.arn,
    username: argoRole.arn,
    groups: ["system:masters"],
  }
  )
  outputs.argoRoleArn = argoRole.arn
}

// Create EKS Cluster with a default node group
// By default pulumi will attempt to apply sane dependency resolution to control
// resource rollouts
// - https://www.pulumi.com/docs/concepts/options/dependson
// let res1 = new MyResource("res1", {/*...*/});
// let res2 = new MyResource("res2", {/*...*/}, { dependsOn: [res1] });

const eksCluster = new eks.Cluster(`${stackName}-cluster`, {
  name: `${stackName}-cluster`,
  vpcId: vpc.vpcId,
  version: "1.29",
  publicSubnetIds: vpc.publicSubnetIds,
  privateSubnetIds: vpc.privateSubnetIds,
  roleMappings: roleMappings,
  nodeSecurityGroupTags: {
    "karpenter.sh/discovery": `${stackName}-cluster`
  },
  createOidcProvider: true,
  clusterTags: {
    "karpenter.sh/discovery": `${stackName}-cluster`,
  },
  nodeGroupOptions: {
    nodeSubnetIds: vpc.privateSubnetIds,
    nodeRootVolumeEncrypted: true,
    nodeRootVolumeType: "gp3",
    instanceType: "t3.medium",
    minSize: 1,
    maxSize: 25,
    desiredCapacity: 4,
  },
  tags: {
    "name": stackName,
  },
},{
})

new aws.eks.Addon("eks-pod-identity-agent", {
  clusterName: eksCluster.eksCluster.name,
  addonName: "eks-pod-identity-agent",
});

outputs.clusterName = eksCluster.eksCluster.name
outputs.clusterApiEndpoint = eksCluster.core.endpoint

const oidcProviderUrl = eksCluster.core.oidcProvider?.url as pulumi.Output<string>
if (clusterComponents.enable_velero) {
  const { veleroIamRole, veleroBucket } = createVeleroResources(awsAccountId, oidcProviderUrl, stackName)
  outputs.veleroBucket = veleroBucket.bucket,
  outputs.veleroIamRoleArn = veleroIamRole.arn
}

// If we are creating the hub cluster we need pods in eks cluster to be able to assume
// so we need cluster created first
if (config.require("clusterType") === "hub") {
  const argoRole = createHubRole(eksCluster.eksCluster.name)
  outputs.argoRoleArn = argoRole.arn
}

// Create the GitOps Configuration for the given cluster, upload
// a file to be added to Github Repo which GitOps Controller could manage
new GitOpsClusterConfig(outputs, config, eksCluster.eksCluster.certificateAuthority.data)