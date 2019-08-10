## The Goal of Stagely CLI

The Stagely CLI allows your to easily create and manage pre-production clusters on AWS.
Stagely leverages the power of [Docker](https://docs.docker.com/), [Kubernetes](https://kubernetes.io/), and [kops](https://github.com/kubernetes/kops) to create ephemeral clusters for quickly testing new features in the cloud. Stagely handles the heavy lifting of creating and managing AWS resources like EC2 instances, VPCs, security groups, and Load Balancers so that you rapidly stage and test new features to ensure quality before pushing into your production environment.

**Not intended for production usage**

# Prerequisites

## Install kops

Before we can bring up the cluster we need to [install the CLI tool](https://github.com/kubernetes/kops/blob/master/docs/install.md) `kops`.

## Install kubectl

In order to control Kubernetes clusters we need to [install the CLI tool](https://github.com/kubernetes/kops/blob/master/docs/install.md) `kubectl`.

#### Other Platforms

* [Kubernetes Latest Release](https://github.com/kubernetes/kubernetes/releases/latest)

* [Installation Guide](http://kubernetes.io/docs/user-guide/prereqs/)

## Setup your environment

### AWS

In order to build clusters within AWS we'll create a dedicated IAM user for `stagely`, we require you to
install the AWS CLI tools, and have API credentials for an account that has

```
AmazonEC2FullAccess
AmazonRoute53FullAccess
AmazonS3FullAccess
IAMFullAccess
AmazonVPCFullAccess
```

Once you've [installed the AWS CLI tools](https://github.com/kubernetes/kops/blob/master/docs/install.md) and have correctly setup
your system to use the official AWS methods of registering security credentials
as [defined here](https://docs.aws.amazon.com/sdk-for-go/v1/developer-guide/configuring-sdk.html#specifying-credentials) we'll be ready to run `stagely`, as it uses the AWS CLI.

## Installing

Via npm:

```bash
$ npm install [-g] stagely
```

Check installation with this comand:


```bash
$ stagely --version
```

## Usage

To start using the stagely CLI, you must first run the `configure` command

```bash
$ stagely configure
```

This will allow you to choose which AWS CLI profile you'd like to use with `stagely`

### Creating a new staging cluster

```bash
$ stagely create cluster
```


This will create all resources required for creating a kops managed Kubernetes cluster, VPC, EC2 instances, Security groups, S3 bucket and NGINX Ingress Controller and Load Balancer

### Deploying an new application within your cluster

```bash
$ stagely deploy <path-to-kubernetes-pod-config>
```

This will deploy the pods defined within the file into your cluster. See [example-app](./deployments/example-app.yaml) for example config file.
**The example Pod template uses host header routing. To use host header routing you must add A records in Route 53 that point to the ingress Load Balancer**

Also, take a look at the official Kubernetes docs for setting up a Pod Template [here](https://kubernetes.io/docs/concepts/workloads/pods/pod-overview/#pod-templates).

### Deleting a  staging cluster

```bash
$ stagely delete cluster
```