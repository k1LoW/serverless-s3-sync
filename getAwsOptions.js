function getAwsOptions(provider) {
  if (provider.cachedCredentials && typeof(provider.cachedCredentials.accessKeyId) != 'undefined'
    && typeof(provider.cachedCredentials.secretAccessKey) != 'undefined'
    && typeof(provider.cachedCredentials.sessionToken) != 'undefined') {

    return {
      // Temporarily disabled the below below because Serverless framework is not interpolating ${env:foo}
      // in provider.credentials.region or provider.cachedCredentials.region
      // region: provider.cachedCredentials.region,
      region: provider.getRegion(),
      credentials: {
        accessKeyId: provider.cachedCredentials.accessKeyId,
        secretAccessKey: provider.cachedCredentials.secretAccessKey,
        sessionToken: provider.cachedCredentials.sessionToken,
      }
    }
  } else {
    return {
      region: provider.getRegion() || provider.getCredentials().region,
      credentials: provider.getCredentials().credentials
    }
  }
}

module.exports = getAwsOptions
