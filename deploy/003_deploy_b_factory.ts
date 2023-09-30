import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

import { getSetupAddresses } from '../src/addresses/setup';

const networkName = {
	4: 'Rinkeby',
	5: 'Goerli',
	1: 'mainnet',
	137: 'matic',
	42: 'kovan',
	100: 'gnosis',
	42161: 'arbitrum',
	10: 'optimism'
};

const networkCurrency = {
	4: 'ETH',
	5: 'ETH',
	1: 'ETH',
	137: 'matic',
	42: 'ETH',
	100: 'xDai',
	42161: 'ETH',
	10: 'ETH'
};

const deployFn: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {

    const { deployments, ethers, getChainId, getNamedAccounts, network } = hre;

    const { deployer } = await getNamedAccounts();
	const chainId = await getChainId();

	const _addresses = await getSetupAddresses(chainId, network, deployments);

	if (_addresses.DAO === ethers.ZeroAddress && network.name !== 'hardhat') {
		console.log('You need to set DAO adress to transfer ownership of summoner', _addresses.DAO);
		return;
	}

	console.log('\n\nDeploying tokens on network:', network.name);
	console.log('Deployer address:', `${chainId}:${deployer}`);
	console.log(
		'Deployer balance:',
		ethers.formatEther(await ethers.provider.getBalance(deployer)),
	);
	const lootSingleton = await deployments.deploy('Loot', {
		from: deployer,
		args: [],
		log: true,
	});
	console.log('Loot deployment Tx ->', lootSingleton.transactionHash);
	console.log('Loot deployment addr ->', lootSingleton.address);
	
	const sharesSingleton = await deployments.deploy('Shares', {
		from: deployer,
		args: [],
		log: true,
	});
	console.log('Shares deployment Tx ->', sharesSingleton.transactionHash);
	console.log('Shares deployment addr ->', sharesSingleton.address);

	console.log('\n\nDeploying Baal (singleton) on network:', network.name);
	console.log('Deployer address:', `${chainId}:${deployer}`);
	console.log(
		'Deployer balance:',
		ethers.formatEther(await ethers.provider.getBalance(deployer)),
	);

	const baalSingleton = await deployments.deploy('Baal', {
		contract: 'Baal',
		from: deployer,
		args: [],
		log: true,
	});

	console.log('\n\nDeploying BaalSummoner factory on network:', network.name);
	console.log('Deployer address:', `${chainId}:${deployer}`);
	console.log(
		'Deployer balance:',
		ethers.formatEther(await ethers.provider.getBalance(deployer)),
	);

	const summonerDeeployed = await deployments.deploy('BaalSummoner', {
		contract: 'BaalSummoner',
		from: deployer,
		args: [],
        proxy: {
            proxyContract: 'OpenZeppelinTransparentProxy',
            methodName: 'initialize',
        },
		log: true,
	});
	console.log('BaalSummoner deployment Tx ->', summonerDeeployed.transactionHash);

	// set addresses of templates and libraries
	const tx_1 = await deployments.execute('BaalSummoner', {
		from: deployer,
	}, 'setAddrs',
		baalSingleton.address, 
		_addresses.gnosisSingleton, 
		_addresses.gnosisFallbackLibrary, 
		_addresses.gnosisMultisendLibrary,
		_addresses.gnosisSafeProxyFactory,
		_addresses.moduleProxyFactory,
		lootSingleton.address,
		sharesSingleton.address
	);
	console.log('BaalSummoner setAddrs Tx ->', tx_1.transactionHash);
	
    
	// transfer ownership to DAO
	if (network.name !== 'hardhat') {
		console.log("BaalSummoner transferOwnership to", _addresses.DAO);
        const tx_2 = await deployments.execute('BaalSummoner', {
            from: deployer,
        }, 'transferOwnership',
            _addresses.DAO
        );
        console.log('BaalSummoner transferOwnership Tx ->', tx_2.transactionHash);
	}
};

export default deployFn;
deployFn.tags = ['Factories', 'BaalSummoner'];
