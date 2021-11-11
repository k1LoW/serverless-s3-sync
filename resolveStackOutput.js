const getAwsOptions = require('./getAwsOptions')

function resolveStackOutput(plugin, outputKey) {
  const provider = plugin.serverless.getProvider('aws');
  const options = getAwsOptions(provider)
  const cfn = new provider.sdk.CloudFormation(options);
  const stackName = provider.naming.getStackName();

  return cfn
    .describeStacks({ StackName: stackName })
    .promise()
    .then(data => {
      const output = data.Stacks[0].Outputs.find(
        e => e.OutputKey === outputKey
      );
      if (!output) {
        throw `Failed to resolve stack Output '${outputKey}' in stack '${stackName}'`;
      }
      return output.OutputValue;
    });
}

module.exports = resolveStackOutput;
