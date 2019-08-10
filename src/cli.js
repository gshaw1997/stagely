import { name, version, description } from '../package.json';
import fs from 'fs';
import arg from 'arg';
import inquirer from 'inquirer';
import chalk from 'chalk';
import shelljs from 'shelljs';

const CONFIG_FILE = 'stagely.config';

const COMMANDS = {
    CONFIGURE: 'configure',
    CREATE: 'create',
    DELETE: 'delete',
    DEPLOY: 'deploy'
}

const CREATE_COMMANDS = {
    CLUSTER: 'cluster'
}

const DELETE_COMMANDS = {
    CLUSTER: 'cluster'
}



/**
 * Takes arguments from `process.argsv` and converts to options args object
 *
 * @param {*} rawArgs [Raw arguments from process.argsv]
 * @returns
 */
function parseArgumentsIntoOptions(rawArgs) {
    const args = arg(
        {
            '--version': Boolean,
            '-v': '--version',
            '--cluster': Boolean,
            '--help': Boolean,
        },
        {
            argv: rawArgs.slice(2)
        }
    )
    return {
        printVersion: args['--version'] || false,
        printHelp: args['--help'] || false,
        createCluster: args['--cluster'] || false,
        command: args._[0],
        chainedCommands: args._.slice(1),
    }
}


/**
 * Handles routing cli commands to functions
 *
 * @param {*} options [The parsed options values]
 */
async function delegateTasks(options) {
    if (options.printVersion) {
        console.log(`\n${name} ${version}\n\n${description}`)
    } else if (options.printHelp) {
        printHelp()
    } else {
        switch (options.command) {
            case COMMANDS.CONFIGURE:
                runConfiguration(options.createCluster);
                break;
            case COMMANDS.CREATE:
                runCreation(options.chainedCommands[0], options.chainedCommands.slice(1));
                break;
            case COMMANDS.DELETE:
                runDeletion(options.chainedCommands[0], options.chainedCommands.slice(1));
                break;
            case COMMANDS.DEPLOY:
                runDeploy(options.chainedCommands[0]);
                break;
            default:
                printHelp();
                break;
        }
    }
}



/**
 * Configures cli AWS Credentials
 *
 * @param {*} createCluster [Whether or not to create a cluster on config]
 */
async function runConfiguration(createCluster) {
    printHeader('Configure AWS profile')
    await configureAWSCredentials(2);
    if (createCluster) {
        await createCluster();
    }
}


/**
 * Delegates creation commands
 *
 * @param {*} createCommand [What create command should be run]
 * @param {*} args [Additional arguments to pass from process.args]
 */
async function runCreation(createCommand, args) {
    switch (createCommand) {
        case CREATE_COMMANDS.CLUSTER:
            createCluster();
            break;
        default:
            break;
    }
}


/**
 * Deploys Pod defined in specified Kubernetes yaml file
 *
 * @param {*} file [The config file to use for deployment]
 */
async function runDeploy(file) {
    const config = await readConfig();
    exposeAWSCredentials(config.awsProfile);
    exposeClusterStateStore(config.clusterStateStore);
    printHeader(`Deploying ${file}`);
    const deployment = shelljs.exec(`kubectl apply -f ${file}`);
    if (deployment.code === 0) {
        console.log(chalk.green.bold('DONE'), `Successfully deployed ${file} into ${config.clusterName}`);
    } else {
        console.log(chalk.red.bold('ERROR'), `Unable to deploy ${file} into ${config.clusterName}`, deployment.stdout);
    }
}


/**
 * Delegates deletion commands
 *
 * @param {*} deleteCommand [The delete command to run]
 * @param {*} args [Additional arguments to pass from process.args]
 */
async function runDeletion(deleteCommand, args) {
    switch (deleteCommand) {
        case DELETE_COMMANDS.CLUSTER:
            deleteCluster()
            break;
        default:
            break;
    }
}


/**
 * Runs interactive prompt for creating a Kubernetes cluster on AWS
 *
 */
async function createCluster() {
    const config = await readConfig(true);
    exposeAWSCredentials(config.awsProfile);
    printHeader('Create your Kubernetes Cluster');
    const clusterConfig = await inquirer.prompt([
        { type: 'input', name: 'name', message: 'Enter a name for your cluster', default: 'mycluster' },
        { type: 'input', name: 'hostedZone', message: 'Enter the hosted zone for your cluster\'s DNS (ie. example.com)', default: 'k8s.local' },
        { type: 'input', name: 'region', message: 'Enter the default region for your cluster.', default: 'us-east-1' }
    ]);
    const describeRegions = shelljs.exec(`aws ec2 describe-availability-zones --region ${clusterConfig.region}`, { silent: true });
    let availableZones = [];
    if (!describeRegions.stderr) {
        const describeResponse = JSON.parse(describeRegions.stdout);
        availableZones = describeResponse.AvailabilityZones.filter(zone => zone.State === 'available').map(zone => zone.ZoneName);
    }
    const clusterZonesConfig = await inquirer.prompt(
        [
            { type: 'checkbox', name: 'zones', message: 'Select the availability zones you would like your cluster to exist in.', choices: availableZones, default: [availableZones[0]] }
        ]);

    const CLUSTER_NAME = `${clusterConfig.name}.${clusterConfig.hostedZone}`;
    const STATE_STORE_PREFIX = `${clusterConfig.name}-state-store`;
    writeConfig('clusterName', CLUSTER_NAME);
    writeConfig('clusterStateStore', STATE_STORE_PREFIX);

    exposeClusterStateStore(STATE_STORE_PREFIX);

    shelljs.exec(`aws s3api create-bucket \
    --bucket ${STATE_STORE_PREFIX} \
    --region ${clusterConfig.region}`);
    shelljs.exec(`aws s3api put-bucket-versioning --bucket ${STATE_STORE_PREFIX}  --versioning-configuration Status=Enabled`);
    shelljs.exec(`aws s3api put-bucket-encryption --bucket ${STATE_STORE_PREFIX} --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'`)

    const clusterCreation = shelljs.exec(`kops create cluster \
    --zones ${clusterZonesConfig.zones} \
    --master-count 1 \
    --master-size=t3.micro \
    --node-count 2 \
    --node-size=t3.micro \
    ${CLUSTER_NAME}
`)

    if (clusterCreation.code === 0) {
        shelljs.exec(`kops update cluster --name ${CLUSTER_NAME} --yes`);
        printHeader('Waiting for cluster to start. This may take a minute.')
        const pollClusterReady = setInterval(() => {
            const validateClusterRes = shelljs.exec('kops validate cluster', { silent: true });
            if (validateClusterRes.code === 0) {
                clearInterval(pollClusterReady);
                printHeader('Installing Kubernetes cluster dashboard')
                shelljs.exec(`kubectl apply -f https://raw.githubusercontent.com/kubernetes/dashboard/v2.0.0-beta1/aio/deploy/recommended.yaml`);
                printHeader('Installing the Ingress Controller')
                shelljs.exec(`kubectl apply -f https://raw.githubusercontent.com/nginxinc/kubernetes-ingress/master/deployments/common/ns-and-sa.yaml`);
                shelljs.exec(`kubectl apply -f https://raw.githubusercontent.com/nginxinc/kubernetes-ingress/master/deployments/common/default-server-secret.yaml`);
                shelljs.exec(`kubectl apply -f https://raw.githubusercontent.com/gshaw1997/stagely/master/deployments/nginx-config.yaml`);
                shelljs.exec(`kubectl apply -f https://raw.githubusercontent.com/nginxinc/kubernetes-ingress/master/deployments/rbac/rbac.yaml`);
                shelljs.exec(`kubectl apply -f https://raw.githubusercontent.com/nginxinc/kubernetes-ingress/master/deployments/deployment/nginx-ingress.yaml`);
                shelljs.exec(`kubectl apply -f https://raw.githubusercontent.com/nginxinc/kubernetes-ingress/master/deployments/daemon-set/nginx-ingress.yaml`);
                shelljs.exec(`kubectl apply -f https://raw.githubusercontent.com/nginxinc/kubernetes-ingress/master/deployments/service/loadbalancer-aws-elb.yaml`);
                console.log(chalk.green.bold('DONE'), `Cluster ${clusterConfig.name} ready.`, loadBalancerDNS)
            }
            console.log('.')
        }, 15000)
    }
}


/**
 * Exposes `KOPS_STATE_STORE` to env
 *
 * @param {*} STATE_STORE_PREFIX [The prefix of the kops state store]
 */
function exposeClusterStateStore(STATE_STORE_PREFIX) {
    process.env.KOPS_STATE_STORE = `s3://${STATE_STORE_PREFIX}`;
    shelljs.exec(`export KOPS_STATE_STORE=s3://${STATE_STORE_PREFIX}`);
}


/**
 * Deletes staging cluster and all associated resources
 *
 */
async function deleteCluster() {
    const config = await readConfig();
    exposeAWSCredentials(config.awsProfile);
    exposeClusterStateStore(config.clusterStateStore);
    printHeader(`Deleting Cluster ${config.clusterName}`);
    const clusterDeletion = shelljs.exec(`kops delete cluster ${config.clusterName} --yes`);
    if (clusterDeletion.code === 0) {
        console.log('Finalizing clean up...');
        shelljs.exec(`sh ./clear-store.sh ${config.clusterStateStore}`, { silent: true });
        shelljs.exec(`aws s3 rb s3://${config.clusterStateStore} --force `, { silent: true })
        console.log(chalk.green.bold('DONE'), 'Cluster deleted successfully');
    } else {
        console.log(chalk.red.bold('ERROR'), 'Problem deleting some of your cluster resources.');
    }
}


/**
 * Configures AWS Credentials by prompting for AWS CLI profile and exposing env
 *
 * @param {*} retries [The number of retries to perform]
 */
async function configureAWSCredentials(retries) {
    const awsConfig = await inquirer.prompt([
        { type: 'input', name: 'profile', message: 'Enter the AWS cli profile you want to use.', default: 'default' },
    ]);
    exposeAWSCredentials(awsConfig.profile, retries);
    writeConfig('awsProfile', awsConfig.profile);
}


/**
 * Exposes AWS Credentials to env
 *
 * @param {*} profile [The profile to expose credentials for]
 * @param {number} [retries=0] [The number of times to retry input on failure]
 * @returns
 */
function exposeAWSCredentials(profile, retries = 0) {
    const accessKeyIdExec = shelljs.exec(`aws configure get aws_access_key_id --profile ${profile}`, { silent: true });
    if (accessKeyIdExec.stderr) {
        if (retries) {
            retries--;
            return configureAWSCredentials(retries);
        } else {
            console.log(chalk.red.bold('ERROR'), `Unable to configure credentials for AWS cli. AWS cli profile '${profile}' does not exist.`);
            process.exit(1);
        }
    }
    else {
        const awsSecretKeyExec = shelljs.exec(`aws configure get aws_secret_access_key --profile ${profile}`, { silent: true });
        shelljs.exec(`export AWS_ACCESS_KEY_ID=${accessKeyIdExec.stdout}`);
        shelljs.exec(`export AWS_SECRET_ACCESS_KEY=${awsSecretKeyExec.stdout}`);
    }
}


/**
 * Prints header to console
 *
 * @param {*} title [The title to be printed in the header]
 */
function printHeader(title) {
    console.log()
    console.log('*********************************************************************************\n');
    console.log(`${title}\n`);
    console.log('*********************************************************************************\n');
}

function printHelp() {
    console.log(`usage: stagely [options] <command> <subcommand> [<subcommand> ...] [parameters]\n`)
    console.log(`Available Commands:
    configure Runs configuration for cli. Must be run once before using.
    create cluster Creates new staging cluster.
    delete cluster Deletes staging cluster and all associated resources.
  `)
}


/**
 * Writes CLI config to file
 *
 * @param {*} key [The key of the property to store]
 * @param {*} value [The value of the property to store]
 */
function writeConfig(key, value) {
    let config = {};
    if (fs.existsSync(CONFIG_FILE)) {
        config = JSON.parse(fs.readFileSync(CONFIG_FILE));
    }
    config[key] = value;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config));
}


/**
 * Reads config from file into memory.
 * Runs configuration prompts if `create` is true
 *
 * @param {*} create [Whether or not to create config if no config file exists]
 * @returns
 */
async function readConfig(create) {
    let config = null;
    if (fs.existsSync(CONFIG_FILE)) {
        config = JSON.parse(fs.readFileSync(CONFIG_FILE));
    }
    if (!config && create) {
        await runConfiguration();
        config = JSON.parse(fs.readFileSync(CONFIG_FILE));
    }
    return config;
}


/**
 * CLI Start function
 *
 * @export
 * @param {*} args [List of arguments from process.argsv]
 */
export function cli(args) {
    const options = parseArgumentsIntoOptions(args);
    delegateTasks(options)
}