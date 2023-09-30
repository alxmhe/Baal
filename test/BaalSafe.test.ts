import { expect } from 'chai';
import { deployments, ethers, getChainId, getNamedAccounts, getUnnamedAccounts } from 'hardhat';
import { calculateProxyAddress } from "@gnosis.pm/zodiac";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

import {
  abiCoder,
  defaultDAOSettings,
  defaultSummonSetup,
  ProposalType,
  PROPOSAL_STATES,
  revertMessages,
  setupBaal,
  SHAMAN_PERMISSIONS,
  verifyProposal,
} from './utils/baal';
import { blockTime, moveForwardPeriods } from './utils/evm';
import { baalSetup, mockBaalLessSharesSetup, ProposalHelpers, Signer } from './utils/fixtures';
import signDelegation from "../src/signDelegation";
import signVote from "../src/signVote";
import { sharesRevertMessages } from './utils/token';
import {
  Shares,
  Baal,
  BaalSummoner,
  Poster,
  GnosisSafe,
  TestERC20,
  Loot,
  MultiSend,
  ModuleProxyFactory,
  TestAvatar,
} from '../src/types';
import { encodeMultiAction, hashOperation } from '../src/util';

const deploymentConfig = {
  ...defaultDAOSettings,
  TOKEN_NAME: "Baal Shares",
  TOKEN_SYMBOL: "BAAL",
};

describe("Baal contract", function () {
  let baal: Baal;
  let baalSummoner: BaalSummoner;
  let lootToken: Loot;
  let sharesToken: Shares;
  let weth: TestERC20;
  let dai: TestERC20;
  let multisend: MultiSend;
  let forwarder: `0x${string}`;
  let gnosisSafe: GnosisSafe;
  let chainId: number;

  let proposal: ProposalType;

  let users: {
    [key: string]: Signer;
  };

  const yes = true;
  const no = false;

  let proposalHelpers: ProposalHelpers;

  beforeEach(async function () {

    forwarder = '0x0000000000000000000000000000000000000420';

    const baalSet = await baalSetup({
      daoSettings: deploymentConfig,
      forwarderAddress: forwarder,
    });

    const {
      Baal,
      Loot,
      Shares,
      BaalSummoner,
      GnosisSafe,
      MultiSend,
      WETH,
      DAI,
      signers,
      helpers,
    } = baalSet;

    baal = Baal;
    lootToken = Loot;
    sharesToken = Shares;
    baalSummoner = BaalSummoner;
    gnosisSafe = GnosisSafe;
    multisend = MultiSend;
    weth = WETH;
    dai = DAI;
    users = signers;

    proposalHelpers = helpers;

    chainId = Number(await getChainId());

    const selfTransferAction = encodeMultiAction(
      multisend,
      ["0x"],
      [await gnosisSafe.getAddress()],
      ['0'],
      [0]
    );

    proposal = {
      flag: 0,
      data: selfTransferAction,
      details: "all hail baal",
      expiration: 0,
      baalGas: 0,
    };
  });

  describe("constructor", function () {
    it("verify deployment parameters", async () => {
      const now = await blockTime();

      const gracePeriod = await baal.gracePeriod();
      expect(gracePeriod).to.equal(deploymentConfig.GRACE_PERIOD_IN_SECONDS);

      const votingPeriod = await baal.votingPeriod();
      expect(votingPeriod).to.equal(deploymentConfig.VOTING_PERIOD_IN_SECONDS);

      const proposalOffering = await baal.proposalOffering();
      expect(proposalOffering).to.equal(deploymentConfig.PROPOSAL_OFFERING);

      expect(await sharesToken.paused()).to.equal(false);
      expect(await lootToken.paused()).to.equal(false);

      const shamans = await baal.shamans(users.shaman.address);
      expect(shamans).to.be.equal(7);

      const summonerLoot = await lootToken.balanceOf(users.summoner.address);
      expect(summonerLoot).to.equal(defaultSummonSetup.loot);

      const summonerVotes = await sharesToken.getVotes(users.summoner.address);
      expect(summonerVotes).to.equal(users.summoner.sharesInitial);

      const summonerSelfDelegates = await sharesToken.delegates(
        users.summoner.address
      );
      expect(summonerSelfDelegates).to.equal(users.summoner.address);

      const summonerShares = await sharesToken.balanceOf(users.summoner.address);
      expect(summonerShares).to.equal(users.summoner.sharesInitial);

      const totalLoot = await baal.totalLoot();
      expect(totalLoot).to.equal(defaultSummonSetup.loot * 2);

      const trustedForwarder = await baal.trustedForwarder();
      expect(trustedForwarder).to.equal(forwarder);
    });
  });

  describe("token ownership", function () {
    it("can not transfer ownership when not owner", async () => {
      expect(await lootToken.owner()).to.equal(await baal.getAddress());

      await expect(lootToken.transferOwnership(users.summoner.address)).to.be.revertedWith(
        revertMessages.OwnableCallerIsNotTheOwner
        );
    });

    it("can not be upgraded when not owner", async () => {
      expect(await lootToken.owner()).to.equal(await baal.getAddress());

      await expect(lootToken.upgradeTo(await sharesToken.getAddress())).to.be.revertedWith(
        revertMessages.OwnableCallerIsNotTheOwner
        );
    });

    it("can renounce loot token ownership", async () => {
      expect(await lootToken.owner()).to.equal(await baal.getAddress());


      const renounceAction = lootToken.interface.encodeFunctionData(
        "renounceOwnership"
      );

      const renounceFromBaal = baal.interface.encodeFunctionData(
        "executeAsBaal",
        [await lootToken.getAddress(), 0, renounceAction]
      );

      const encodedAction = encodeMultiAction(
        multisend,
        [renounceFromBaal],
        [await baal.getAddress()],
        ['0'],
        [0]
      );

      await expect(
        proposalHelpers.submitAndProcessProposal({
          baal,
          encodedAction,
          proposal,
          proposalId: 1
        })
      )
      .to.emit(baal, "ProcessProposal")
      .withArgs(1, true, false);

      expect(await lootToken.owner()).to.equal(ethers.ZeroAddress);
    });


    it("can renounce shares token ownership", async () => {
      expect(await sharesToken.owner()).to.equal(await baal.getAddress());

      const renounceAction = sharesToken.interface.encodeFunctionData(
        "renounceOwnership"
      );

      const renounceFromBaal = baal.interface.encodeFunctionData(
        "executeAsBaal",
        [await sharesToken.getAddress(), 0, renounceAction]
      );

      const encodedAction = encodeMultiAction(
        multisend,
        [renounceFromBaal],
        [await baal.getAddress()],
        ['0'],
        [0]
      );

      await expect(
        proposalHelpers.submitAndProcessProposal({
          baal,
          encodedAction,
          proposal,
          proposalId: 1
        })
      )
      .to.emit(baal, "ProcessProposal")
      .withArgs(1, true, false);

      expect(await sharesToken.owner()).to.equal(ethers.ZeroAddress);
    });

    it("can change loot token ownership to avatar", async () => {
      expect(await lootToken.owner()).to.equal(await baal.getAddress());

      const transferOwnershipAction = await lootToken.interface.encodeFunctionData(
        "transferOwnership",
        [await gnosisSafe.getAddress()]
      );

      const transferOwnershipFromBaal = await baal.interface.encodeFunctionData(
        "executeAsBaal",
        [await lootToken.getAddress(), 0, transferOwnershipAction]
      );

      const encodedAction = encodeMultiAction(
        multisend,
        [transferOwnershipFromBaal],
        [await baal.getAddress()],
        ['0'],
        [0]
      );

      await expect(
        proposalHelpers.submitAndProcessProposal({
          baal,
          encodedAction,
          proposal,
          proposalId: 1
        })
      )
      .to.emit(baal, "ProcessProposal")
      .withArgs(1, true, false);

      expect(await lootToken.owner()).to.equal(await gnosisSafe.getAddress());
    });

    it("can change shares token ownership to avatar", async () => {
      expect(await sharesToken.owner()).to.equal(await baal.getAddress());

      const transferOwnershipAction = await sharesToken.interface.encodeFunctionData(
        "transferOwnership",
        [await gnosisSafe.getAddress()]
      );

      const transferOwnershipFromBaal = await baal.interface.encodeFunctionData(
        "executeAsBaal",
        [await sharesToken.getAddress(), 0, transferOwnershipAction]
      );

      const encodedAction = encodeMultiAction(
        multisend,
        [transferOwnershipFromBaal],
        [await baal.getAddress()],
        ['0'],
        [0]
      );

      await expect(
        proposalHelpers.submitAndProcessProposal({
          baal,
          encodedAction,
          proposal,
          proposalId: 1
        })
      )
      .to.emit(baal, "ProcessProposal")
      .withArgs(1, true, false);

      expect(await sharesToken.owner()).to.equal(await gnosisSafe.getAddress());
    });

    it("can eject and upgrade token with eoa", async () => {
      // upgrade token contracts to remove baal deps
      // call from safe
      // remove baal module

      // owner should be baal
      expect(await sharesToken.owner()).to.equal(await baal.getAddress());

      const transferOwnershipAction = await sharesToken.interface.encodeFunctionData(
        "transferOwnership",
        [users.summoner.address]
      );

      const transferOwnershipFromBaal = await baal.interface.encodeFunctionData(
        "executeAsBaal",
        [await sharesToken.getAddress(), 0, transferOwnershipAction]
      );

      const encodedAction = encodeMultiAction(
        multisend,
        [transferOwnershipFromBaal],
        [await baal.getAddress()],
        ['0'],
        [0]
      );

      await expect(
        proposalHelpers.submitAndProcessProposal({
          baal,
          encodedAction,
          proposal,
          proposalId: 1
        })
      )
      .to.emit(baal, "ProcessProposal")
      .withArgs(1, true, false);
  
      expect(await sharesToken.owner()).to.equal(users.summoner.address);


      // Upgrade Token
      const { BaalLessShares } = await mockBaalLessSharesSetup();
      const baalLessSharesSingleton = BaalLessShares;
      
      expect(await baalLessSharesSingleton.version()).to.equal(0);

      const cShares = await ethers.getContractAt(
        "Shares", await users.summoner.shares!.getAddress(),
        // @ts-expect-error
        await ethers.getSigner(users.summoner.address)
      );

      const tx = await cShares.upgradeToAndCall(
        await baalLessSharesSingleton.getAddress(),
        baalLessSharesSingleton.interface.encodeFunctionData("setUp", [
          2
        ])
      );

      // after upgrade token should have same balances
      // after upgrade token should have a version
      expect(
        await sharesToken.balanceOf(users.summoner.address)
      ).to.equal(users.summoner.sharesInitial);
      const newTokenInterface = baalLessSharesSingleton.attach(await sharesToken.getAddress());
      expect(await newTokenInterface.version()).to.equal(2);
      expect(await newTokenInterface.baal()).to.equal(ethers.ZeroAddress);

      // new owner should be able to mint
      await cShares.mint(users.summoner.address, 100);

      expect(
        await sharesToken.balanceOf(users.summoner.address)
      ).to.equal(BigInt(users.summoner.sharesInitial) + BigInt(100));
    });
  });

  describe("shaman actions - permission level 7 (full)", function () {
    const amountToMint = 69;
    let currentTotalLoot: bigint;
    let currentTotalShares: bigint;

    this.beforeEach(async function() {
      currentTotalLoot = BigInt(users.summoner.lootInitial) + BigInt(users.applicant.lootInitial);
      currentTotalShares = BigInt(users.summoner.sharesInitial) + BigInt(users.applicant.sharesInitial);
    });

    it("setAdminConfig", async () => {
      await users.shaman.baal?.setAdminConfig(true, true);
      expect(await sharesToken.paused()).to.equal(true);
      expect(await lootToken.paused()).to.equal(true);
    });

    it("mint shares - recipient has shares", async () => {
      await users.shaman.baal?.mintShares([users.summoner.address], [amountToMint]);
      expect(
        await sharesToken.balanceOf(users.summoner.address)
      ).to.equal(BigInt(users.summoner.sharesInitial) + BigInt(amountToMint));
      const votes = await sharesToken.getVotes(users.summoner.address);
      expect(votes).to.equal(BigInt(users.summoner.sharesInitial) + BigInt(amountToMint));
      const totalShares = await baal.totalShares();
      expect(totalShares).to.equal(
        BigInt(users.summoner.sharesInitial)
        + BigInt(amountToMint)
        + BigInt(users.applicant.sharesInitial)
      );
    });

    it("mint shares - new recipient", async () => {
      await users.shaman.baal?.mintShares([users.shaman.address], [amountToMint]);
      await blockTime();
      expect(await sharesToken.balanceOf(users.shaman.address)).to.equal(BigInt(amountToMint));

      const votes = await sharesToken.getVotes(users.shaman.address);
      expect(votes).to.equal(BigInt(amountToMint));

      const shamanDelegate = await sharesToken.delegates(users.shaman.address);
      expect(shamanDelegate).to.equal(users.shaman.address);
    });

    it("mint shares - recipient has delegate - new shares are also delegated", async () => {
      await users.summoner.shares?.delegate(users.shaman.address);
      // await blockTime();
      await users.shaman.baal?.mintShares([users.summoner.address], [amountToMint]);

      expect(
        await sharesToken.balanceOf(users.summoner.address)
      ).to.equal(BigInt(users.summoner.sharesInitial) + BigInt(amountToMint));

      const summonerVotes = await sharesToken.getVotes(users.summoner.address);
      expect(summonerVotes).to.equal(BigInt(0));

      const shamanVotes = await sharesToken.getVotes(users.shaman.address);
      expect(shamanVotes).to.equal(BigInt(users.summoner.sharesInitial) + BigInt(amountToMint));

      const summonerDelegate = await sharesToken.delegates(users.summoner.address);
      expect(summonerDelegate).to.equal(users.shaman.address);
    });

    it("mint shares - zero mint amount - no votes", async () => {
      await users.shaman.baal?.mintShares([users.shaman.address], [0]);
      // await blockTime();
      expect(await sharesToken.balanceOf(users.shaman.address)).to.equal(BigInt(0));
      const votes = await sharesToken.getVotes(users.shaman.address);
      expect(votes).to.equal(BigInt(0));
      const totalShares = await sharesToken.totalSupply();
      expect(totalShares).to.equal(BigInt(currentTotalShares));

      const shamanVotes = await sharesToken.getVotes(users.shaman.address);
      expect(shamanVotes).to.equal(BigInt(0));

      const shamanDelegate = await sharesToken.delegates(users.shaman.address);
      expect(shamanDelegate).to.equal(ethers.ZeroAddress);
    });

    it("mint shares - require fail - array parity", async () => {
      await expect(
        users.shaman.baal?.mintShares([users.summoner.address], [amountToMint, amountToMint])
      ).to.be.revertedWith(revertMessages.mintSharesArrayParity);
    });

    it("burn shares", async () => {
      await users.shaman.baal?.burnShares([users.summoner.address], [amountToMint]);
      expect(
        await sharesToken.balanceOf(users.summoner.address)
      ).to.equal(BigInt(users.summoner.sharesInitial) - BigInt(amountToMint));
    });

    it("burn shares - require fail - array parity", async () => {
      await expect(
        users.shaman.baal?.burnShares([users.summoner.address], [amountToMint, amountToMint])
      ).to.be.revertedWith(revertMessages.burnSharesArrayParity);
    });

    it("burn shares - require fail - insufficent shares", async () => {
      await expect(
        users.shaman.baal?.burnShares([users.summoner.address], [users.summoner.sharesInitial + 1])
      ).to.be.revertedWith(revertMessages.burnSharesInsufficientShares);
    });

    it("mint loot", async () => {
      await users.shaman.baal?.mintLoot([users.summoner.address], [amountToMint]);
      expect(
        await lootToken.balanceOf(users.summoner.address)
      ).to.equal(BigInt(defaultSummonSetup.loot) + BigInt(amountToMint));
      expect(await baal.totalLoot()).to.equal(BigInt(currentTotalLoot) + BigInt(amountToMint));
    });

    it("mint loot - require fail - array parity", async () => {
      await expect(
        users.shaman.baal?.mintLoot([users.summoner.address], [amountToMint, amountToMint])
      ).to.be.revertedWith(revertMessages.mintSharesArrayParity);
    });

    it("burn loot", async () => {
      await users.shaman.baal?.burnLoot([users.summoner.address], [amountToMint]);
      expect(await lootToken.balanceOf(users.summoner.address)).to.equal(BigInt(defaultSummonSetup.loot) - BigInt(amountToMint));
      expect(await baal.totalLoot()).to.equal(BigInt(currentTotalLoot) - BigInt(amountToMint));
    });

    it("burn loot - require fail - array parity", async () => {
      await expect(
        users.shaman.baal?.burnLoot([users.summoner.address], [amountToMint, amountToMint])
      ).to.be.revertedWith(revertMessages.burnLootArrayParity);
    });

    it("burn loot - require fail - insufficent shares", async () => {
      await expect(
        users.shaman.baal?.burnLoot([users.summoner.address], [defaultSummonSetup.loot + 1])
      ).to.be.revertedWith(revertMessages.burnLootInsufficientShares);
    });

    it("set trusted forwarder", async () => {
      const newForwarderAddress = '0x0000000000000000000000000000000000000421';
      await users.shaman.baal?.setTrustedForwarder(newForwarderAddress);
      expect(await baal.trustedForwarder()).to.equal(newForwarderAddress);
    });

    it("have shaman mint and burn _delegated_ shares", async () => {
      const minting = BigInt(100);

      expect(await sharesToken.balanceOf(users.applicant.address)).to.equal(BigInt(users.applicant.sharesInitial));

      // mint shares for a separate member than the summoner
      await users.shaman.baal?.mintShares([users.applicant.address], [minting]);

      expect(await sharesToken.balanceOf(users.applicant.address)).to.equal(BigInt(users.applicant.sharesInitial) + minting);
      expect(await sharesToken.delegates(users.applicant.address)).to.equal(
        users.applicant.address
      );
      expect(await sharesToken.getVotes(users.applicant.address)).to.equal(BigInt(users.applicant.sharesInitial) + minting);
      expect(await sharesToken.getVotes(users.summoner.address)).to.equal(BigInt(users.summoner.sharesInitial));

      // delegate shares from applicant to the summoner
      // const baalAsApplicant = sharesToken.connect(applicant);

      await expect(users.applicant.shares?.delegate(users.summoner.address))
        .to.emit(sharesToken, 'DelegateChanged')
        .withArgs(users.applicant.address, users.applicant.address, users.summoner.address)
        .to.emit(sharesToken, 'DelegateVotesChanged')
        .withArgs(
          users.summoner.address, 
          BigInt(users.summoner.sharesInitial),
          BigInt(users.summoner.sharesInitial) + BigInt(users.applicant.sharesInitial) + minting
        );

      expect(await sharesToken.balanceOf(users.applicant.address)).to.equal(BigInt(users.applicant.sharesInitial) + minting);
      expect(await sharesToken.delegates(users.applicant.address)).to.equal(
        users.summoner.address
      );
      expect(await sharesToken.getVotes(users.applicant.address)).to.equal(BigInt(0));
      expect(await sharesToken.getVotes(users.summoner.address)).to.equal(
        BigInt(users.summoner.sharesInitial)
        + BigInt(users.applicant.sharesInitial)
        + minting
      );

      // mint shares for the delegator
      await expect(users.shaman.baal?.mintShares([users.applicant.address], [minting]))
        .to.emit(sharesToken, 'DelegateVotesChanged')
        .withArgs(
          users.summoner.address,
          BigInt(users.summoner.sharesInitial) + BigInt(users.applicant.sharesInitial) + minting,
          BigInt(users.summoner.sharesInitial) + BigInt(users.applicant.sharesInitial) + (BigInt(2) * minting)
        );

      expect(await sharesToken.balanceOf(users.applicant.address)).to.equal(
        BigInt(users.applicant.sharesInitial) + (BigInt(2) * minting)
      );
      expect(await sharesToken.delegates(users.applicant.address)).to.equal(
        users.summoner.address
      );
      expect(await sharesToken.getVotes(users.applicant.address)).to.equal(0);
      expect(await sharesToken.getVotes(users.summoner.address)).to.equal(
        BigInt(users.summoner.sharesInitial)
        + BigInt(users.applicant.sharesInitial)
        + (BigInt(2) * minting)
      );

      // burn shares for the delegator
      await users.shaman.baal?.burnShares([users.applicant.address], [minting]);

      expect(await sharesToken.balanceOf(users.applicant.address)).to.equal(
        BigInt(defaultSummonSetup.shares) + minting
      );
      expect(await sharesToken.delegates(users.applicant.address)).to.equal(
        users.summoner.address
      );
      expect(await sharesToken.getVotes(users.applicant.address)).to.equal(
        BigInt(defaultSummonSetup.shares) - minting
      );
      expect(await sharesToken.getVotes(users.summoner.address)).to.equal(
        BigInt(users.summoner.sharesInitial)
        + BigInt(users.applicant.sharesInitial)
        + minting
      );
    });

    it("setGovernanceConfig", async () => {
      const governanceConfig = abiCoder.encode(
        ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256"],
        [10, 20, 50, 1, 2, 3]
      );

      await users.shaman.baal?.setGovernanceConfig(governanceConfig);
      const voting = await baal.votingPeriod();
      const grace = await baal.gracePeriod();
      const offering = await baal.proposalOffering();
      const quorum = await baal.quorumPercent();
      const sponsorThreshold = await baal.sponsorThreshold();
      const minRetentionPercent = await baal.minRetentionPercent();
      expect(voting).to.be.equal(10);
      expect(grace).to.be.equal(20);
      expect(offering).to.be.equal(50);
      expect(quorum).to.be.equal(1);
      expect(sponsorThreshold).to.be.equal(2);
      expect(minRetentionPercent).to.equal(3);
    });

    it("setGovernanceConfig - doesnt set voting/grace if =0", async () => {
      const governanceConfig = abiCoder.encode(
        ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256"],
        [0, 0, 50, 1, 2, 3]
      );

      await users.shaman.baal?.setGovernanceConfig(governanceConfig);
      const voting = await baal.votingPeriod();
      const grace = await baal.gracePeriod();
      const offering = await baal.proposalOffering();
      const quorum = await baal.quorumPercent();
      const sponsorThreshold = await baal.sponsorThreshold();
      const minRetentionPercent = await baal.minRetentionPercent();
      expect(voting).to.be.equal(deploymentConfig.VOTING_PERIOD_IN_SECONDS);
      expect(grace).to.be.equal(deploymentConfig.GRACE_PERIOD_IN_SECONDS);
      expect(offering).to.be.equal(50);
      expect(quorum).to.be.equal(1);
      expect(sponsorThreshold).to.be.equal(2);
      expect(minRetentionPercent).to.equal(3);
    });

    it("cancelProposal - happy case - as gov shaman", async () => {
      await baal.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      await users.shaman.baal?.cancelProposal(1); // cancel as gov shaman
      const state = await baal.state(1);
      expect(state).to.equal(PROPOSAL_STATES.CANCELLED);
    });

    it("cancelProposal - happy case - as proposal sponsor", async () => {
      await baal.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      await baal.cancelProposal(1); // cancel as sponsor
      const state = await baal.state(1);
      expect(state).to.equal(PROPOSAL_STATES.CANCELLED);
    });

    // TODO: get prior votes is 100 and threshold is 1
    it("cancelProposal - happy case - after undelegation", async () => {
      await baal.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      // transfer all shares/votes to shaman
      await users.summoner.shares?.transfer(
        users.shaman.address,
        users.summoner.sharesInitial
      ); 
      await users.applicant.baal?.cancelProposal(1); // cancel as rando
      const state = await baal.state(1);
      expect(state).to.equal(PROPOSAL_STATES.CANCELLED);
    });

    it("cancelProposal - require fail - not cancellable by rando", async () => {
      await baal.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      expect(users.applicant.baal?.cancelProposal(1)).to.be.revertedWith(
        revertMessages.cancelProposalNotCancellable
      );
    });

    it("cancelProposal - require fail - !voting (submitted)", async () => {
      await users.shaman.baal?.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      const state = await baal.state(1);
      expect(state).to.equal(PROPOSAL_STATES.SUBMITTED);
      await expect(baal.cancelProposal(1)).to.be.revertedWith(
        revertMessages.cancelProposalNotVoting
      );
    });

    it("cancelProposal - require fail - !voting (grace)", async () => {
      await users.summoner.baal?.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      // add 1 extra second to push us into grace period
      await moveForwardPeriods(
        defaultDAOSettings.VOTING_PERIOD_IN_SECONDS,
        1,
        1
      );
      const state = await baal.state(1);
      expect(state).to.equal(PROPOSAL_STATES.GRACE);
      await expect(baal.cancelProposal(1)).to.be.revertedWith(
        revertMessages.cancelProposalNotVoting
      );
    });

    it("cancelProposal - require fail - !voting (defeated)", async () => {
      await baal.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      await moveForwardPeriods(defaultDAOSettings.VOTING_PERIOD_IN_SECONDS, 2);
      const state = await baal.state(1);
      expect(state).to.equal(PROPOSAL_STATES.DEEFEATED);
      await expect(baal.cancelProposal(1)).to.be.revertedWith(
        revertMessages.cancelProposalNotVoting
      );
    });

    it("cancelProposal - require fail - !voting (cancelled)", async () => {
      await baal.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      await baal.cancelProposal(1);
      const state = await baal.state(1);
      expect(state).to.equal(PROPOSAL_STATES.CANCELLED);
      await expect(baal.cancelProposal(1)).to.be.revertedWith(
        revertMessages.cancelProposalNotVoting
      );
    });

    it("cancelProposal - require fail - !voting (ready)", async () => {
      await baal.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      await baal.submitVote(1, true);
      await moveForwardPeriods(defaultDAOSettings.VOTING_PERIOD_IN_SECONDS, 2);
      const state = await baal.state(1);
      expect(state).to.equal(PROPOSAL_STATES.READY);
      await expect(baal.cancelProposal(1)).to.be.revertedWith(
        revertMessages.cancelProposalNotVoting
      );
    });

    it("cancelProposal - require fail - !voting (processed)", async () => {
      await baal.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      await baal.submitVote(1, true);
      await moveForwardPeriods(defaultDAOSettings.VOTING_PERIOD_IN_SECONDS, 2);
      await baal.processProposal(1, proposal.data);
      const state = await baal.state(1);
      expect(state).to.equal(PROPOSAL_STATES.PROCESSED);
      await expect(baal.cancelProposal(1)).to.be.revertedWith(
        revertMessages.cancelProposalNotVoting
      );
    });
  });

  describe("shaman permissions: 0-6", function () {
    const governanceConfig = abiCoder.encode(
      ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256"],
      [10, 20, 50, 1, 2, 3]
    );
    const newForwarderAddress = '0x0000000000000000000000000000000000000421';

    beforeEach(async function () {
      const shamanAddresses = [
        users.shaman.address,
        users.s1.address,
        users.s2.address,
        users.s3.address,
        users.s4.address,
        users.s5.address,
        users.s6.address,
      ];
      const permissions = [0, 1, 2, 3, 4, 5, 6];
      const setShaman = baal.interface.encodeFunctionData("setShamans", [
        shamanAddresses,
        permissions,
      ]);
      const setShamanAction = encodeMultiAction(
        multisend,
        [setShaman],
        [await baal.getAddress()],
        ['0'],
        [0]
      );
      
      proposal.data = setShamanAction;
      proposal.details = 'Shaman Proposal';

      await baal.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      await baal.submitVote(1, true);
      await moveForwardPeriods(defaultDAOSettings.VOTING_PERIOD_IN_SECONDS, 2);
      await baal.processProposal(1, proposal.data);
      const shamanPermission = await baal.shamans(users.shaman.address);
      expect(shamanPermission).to.equal(0);
    });

    it("permission = 0 - all actions fail", async () => {
      // admin
      await expect(users.shaman.baal?.setAdminConfig(true, true)).to.be.revertedWith(
        revertMessages.baalOrAdmin
      );

      // manager
      await expect(
        users.shaman.baal?.mintShares([users.shaman.address], [69])
      ).to.be.revertedWith(revertMessages.baalOrManager);
      await expect(
        users.shaman.baal?.burnShares([users.shaman.address], [69])
      ).to.be.revertedWith(revertMessages.baalOrManager);
      await expect(
        users.shaman.baal?.mintLoot([users.shaman.address], [69])
      ).to.be.revertedWith(revertMessages.baalOrManager);
      await expect(
        users.shaman.baal?.burnLoot([users.shaman.address], [69])
      ).to.be.revertedWith(revertMessages.baalOrManager);

      // governor
      await expect(
        users.shaman.baal?.setGovernanceConfig(governanceConfig)
      ).to.be.revertedWith(revertMessages.baalOrGovernor);

      await baal.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      await expect(users.shaman.baal?.cancelProposal(2)).to.be.revertedWith(
        revertMessages.cancelProposalNotCancellable
      );
      await expect(users.shaman.baal?.setTrustedForwarder(forwarder)).to.be.revertedWith(
        revertMessages.baalOrGovernor
      );
    });

    it("permission = 1 - admin actions succeed", async () => {
      // admin - success
      await users.s1.baal?.setAdminConfig(true, true);
      expect(await sharesToken.paused()).to.equal(true);
      expect(await lootToken.paused()).to.equal(true);

      // manager - fail
      expect(users.s1.baal?.mintShares([users.s1.address], [69])).to.be.revertedWith(
        revertMessages.baalOrManager
      );
      expect(users.s1.baal?.burnShares([users.s1.address], [69])).to.be.revertedWith(
        revertMessages.baalOrManager
      );
      expect(users.s1.baal?.mintLoot([users.s1.address], [69])).to.be.revertedWith(
        revertMessages.baalOrManager
      );
      expect(users.s1.baal?.burnLoot([users.s1.address], [69])).to.be.revertedWith(
        revertMessages.baalOrManager
      );

      // governor - fail
      expect(users.s1.baal?.setGovernanceConfig(governanceConfig)).to.be.revertedWith(
        revertMessages.baalOrGovernor
      );
      expect(users.s1.baal?.setTrustedForwarder(forwarder)).to.be.revertedWith(
        revertMessages.baalOrGovernor
      );

      await baal.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      expect(users.s1.baal?.cancelProposal(2)).to.be.revertedWith(
        revertMessages.cancelProposalNotCancellable
      );
    });

    it("permission = 2 - manager actions succeed", async () => {
      // admin - fail
      expect(users.s2.baal?.setAdminConfig(true, true)).to.be.revertedWith(
        revertMessages.baalOrAdmin
      );

      // manager - success
      await users.s2.baal?.mintShares([users.s2.address], [69]);
      expect(await sharesToken.balanceOf(users.s2.address)).to.equal(69);
      await users.s2.baal?.burnShares([users.s2.address], [69]);
      expect(await sharesToken.balanceOf(users.s2.address)).to.equal(0);
      await users.s2.baal?.mintLoot([users.s2.address], [69]);
      expect(await lootToken.balanceOf(users.s2.address)).to.equal(69);
      await users.s2.baal?.burnLoot([users.s2.address], [69]);
      expect(await lootToken.balanceOf(users.s2.address)).to.equal(0);

      // cleanup - mint summoner shares so they can submit/sponsor
      await users.s2.baal?.mintShares([users.summoner.address], [100]);

      // governor - fail
      expect(users.s2.baal?.setGovernanceConfig(governanceConfig)).to.be.revertedWith(
        revertMessages.baalOrGovernor
      );
      await expect(users.s2.baal?.setTrustedForwarder(forwarder)).to.be.revertedWith(
        revertMessages.baalOrGovernor
      );

      await baal.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      expect(users.s2.baal?.cancelProposal(2)).to.be.revertedWith(
        revertMessages.cancelProposalNotCancellable
      );
    });

    it("permission = 3 - admin + manager actions succeed", async () => {
      // admin - success
      await users.s3.baal?.setAdminConfig(true, true);
      expect(await sharesToken.paused()).to.equal(true);
      expect(await lootToken.paused()).to.equal(true);

      // manager - success
      await users.s3.baal?.mintShares([users.s3.address], [69]);
      expect(await sharesToken.balanceOf(users.s3.address)).to.equal(69);
      await users.s3.baal?.burnShares([users.s3.address], [69]);
      expect(await sharesToken.balanceOf(users.s3.address)).to.equal(0);
      await users.s3.baal?.mintLoot([users.s3.address], [69]);
      expect(await lootToken.balanceOf(users.s3.address)).to.equal(69);
      await users.s3.baal?.burnLoot([users.s3.address], [69]);
      expect(await lootToken.balanceOf(users.s3.address)).to.equal(0);

      // cleanup - mint summoner shares so they can submit/sponsor
      await users.s3.baal?.mintShares([users.summoner.address], [100]);

      // governor - fail
      expect(users.s3.baal?.setGovernanceConfig(governanceConfig)).to.be.revertedWith(
        revertMessages.baalOrGovernor
      );
      expect(users.s3.baal?.setTrustedForwarder(forwarder)).to.be.revertedWith(
        revertMessages.baalOrGovernor
      );

      await baal.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      expect(users.s3.baal?.cancelProposal(2)).to.be.revertedWith(
        revertMessages.cancelProposalNotCancellable
      );
    });

    it("permission = 4 - governor actions succeed", async () => {
      // admin - fail
      await expect(users.s4.baal?.setAdminConfig(true, true)).to.be.revertedWith(
        revertMessages.baalOrAdmin
      );

      // manager - fail
      await expect(users.s4.baal?.mintShares([users.s4.address], [69])).to.be.revertedWith(
        revertMessages.baalOrManager
      );
      await expect(users.s4.baal?.burnShares([users.s4.address], [69])).to.be.revertedWith(
        revertMessages.baalOrManager
      );
      await expect(users.s4.baal?.mintLoot([users.s4.address], [69])).to.be.revertedWith(
        revertMessages.baalOrManager
      );
      await expect(users.s4.baal?.burnLoot([users.s4.address], [69])).to.be.revertedWith(
        revertMessages.baalOrManager
      );

      // governor - succeed
      await users.s4.baal?.setGovernanceConfig(governanceConfig);
      const voting = await baal.votingPeriod();
      const grace = await baal.gracePeriod();
      const offering = await baal.proposalOffering();
      const quorum = await baal.quorumPercent();
      const sponsorThreshold = await baal.sponsorThreshold();
      expect(voting).to.be.equal(10);
      expect(grace).to.be.equal(20);
      expect(offering).to.be.equal(50);
      expect(quorum).to.be.equal(1);
      expect(sponsorThreshold).to.be.equal(2);

      await baal.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      await users.s4.baal?.cancelProposal(2);
      const state = await baal.state(2);
      expect(state).to.equal(PROPOSAL_STATES.CANCELLED);

      await users.s4.baal?.setTrustedForwarder(newForwarderAddress);
      expect(await users.s4.baal?.trustedForwarder()).to.equal(newForwarderAddress);
    });

    it("permission = 5 - admin + governor actions succeed", async () => {
      // admin - success
      await users.s5.baal?.setAdminConfig(true, true);
      expect(await sharesToken.paused()).to.equal(true);
      expect(await lootToken.paused()).to.equal(true);

      // manager - fail
      expect(users.s5.baal?.mintShares([users.s5.address], [69])).to.be.revertedWith(
        revertMessages.baalOrManager
      );
      expect(users.s5.baal?.burnShares([users.s5.address], [69])).to.be.revertedWith(
        revertMessages.baalOrManager
      );
      expect(users.s5.baal?.mintLoot([users.s5.address], [69])).to.be.revertedWith(
        revertMessages.baalOrManager
      );
      expect(users.s5.baal?.burnLoot([users.s5.address], [69])).to.be.revertedWith(
        revertMessages.baalOrManager
      );

      // governor - succeed
      await users.s5.baal?.setGovernanceConfig(governanceConfig);
      const voting = await baal.votingPeriod();
      const grace = await baal.gracePeriod();
      const offering = await baal.proposalOffering();
      const quorum = await baal.quorumPercent();
      const sponsorThreshold = await baal.sponsorThreshold();
      expect(voting).to.be.equal(10);
      expect(grace).to.be.equal(20);
      expect(offering).to.be.equal(50);
      expect(quorum).to.be.equal(1);
      expect(sponsorThreshold).to.be.equal(2);

      await baal.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      await users.s5.baal?.cancelProposal(2);
      const state = await baal.state(2);
      expect(state).to.equal(PROPOSAL_STATES.CANCELLED);

      await users.s5.baal?.setTrustedForwarder(newForwarderAddress);
      expect(await users.s5.baal?.trustedForwarder()).to.equal(newForwarderAddress);
    });

    it("permission = 6 - manager + governor actions succeed", async () => {
      // admin - fail
      expect(users.s6.baal?.setAdminConfig(true, true)).to.be.revertedWith(
        revertMessages.baalOrAdmin
      );

      // manager - success
      await users.s6.baal?.mintShares([users.s6.address], [69]);
      expect(await sharesToken.balanceOf(users.s6.address)).to.equal(69);
      await users.s6.baal?.burnShares([users.s6.address], [69]);
      expect(await sharesToken.balanceOf(users.s6.address)).to.equal(0);
      await users.s6.baal?.mintLoot([users.s6.address], [69]);
      expect(await lootToken.balanceOf(users.s6.address)).to.equal(69);
      await users.s6.baal?.burnLoot([users.s6.address], [69]);
      expect(await lootToken.balanceOf(users.s6.address)).to.equal(0);

      // cleanup - mint summoner shares so they can submit/sponsor
      await users.s6.baal?.mintShares([users.summoner.address], [100]);

      // governor - succeed
      await users.s6.baal?.setGovernanceConfig(governanceConfig);
      const voting = await baal.votingPeriod();
      const grace = await baal.gracePeriod();
      const offering = await baal.proposalOffering();
      const quorum = await baal.quorumPercent();
      const sponsorThreshold = await baal.sponsorThreshold();
      expect(voting).to.be.equal(10);
      expect(grace).to.be.equal(20);
      expect(offering).to.be.equal(50);
      expect(quorum).to.be.equal(1);
      expect(sponsorThreshold).to.be.equal(2);

      await baal.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      await users.s6.baal?.cancelProposal(2);
      const state = await baal.state(2);
      expect(state).to.equal(PROPOSAL_STATES.CANCELLED);

      await users.s6.baal?.setTrustedForwarder(newForwarderAddress);
      expect(await users.s6.baal?.trustedForwarder()).to.equal(newForwarderAddress);
    });
  });

  describe("shaman locks", function () {

    it("lockAdmin", async function () {
      const lockAdmin = baal.interface.encodeFunctionData("lockAdmin");
      const lockAdminAction = encodeMultiAction(
        multisend,
        [lockAdmin],
        [await baal.getAddress()],
        ['0'],
        [0]
      );

      proposal.data = lockAdminAction;
      proposal.details = 'Shaman Locks';

      await baal.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      await baal.submitVote(1, true);
      await moveForwardPeriods(defaultDAOSettings.VOTING_PERIOD_IN_SECONDS, 2);
      await baal.processProposal(1, proposal.data);
      expect(await baal.adminLock()).to.equal(true);
    });

    it("lockManager", async () => {
      const lockManager = baal.interface.encodeFunctionData(
        "lockManager"
      );
      const lockManagerAction = encodeMultiAction(
        multisend,
        [lockManager],
        [await baal.getAddress()],
        ['0'],
        [0]
      );
      proposal.data = lockManagerAction;
      await baal.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      await baal.submitVote(1, true);
      await moveForwardPeriods(defaultDAOSettings.VOTING_PERIOD_IN_SECONDS, 2);
      await baal.processProposal(1, proposal.data);
      expect(await baal.managerLock()).to.equal(true);
    });

    it("lockGovernor", async () => {
      const lockGovernor = await baal.interface.encodeFunctionData(
        "lockGovernor"
      );
      const lockGovernorAction = encodeMultiAction(
        multisend,
        [lockGovernor],
        [await baal.getAddress()],
        ['0'],
        [0]
      );
      proposal.data = lockGovernorAction;
      await baal.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      await baal.submitVote(1, true);
      await moveForwardPeriods(defaultDAOSettings.VOTING_PERIOD_IN_SECONDS, 2);
      await baal.processProposal(1, proposal.data);
      expect(await baal.governorLock()).to.equal(true);
    });
  });

  describe("setShamans - adminLock (1, 3, 5, 7)", function () {

    beforeEach(async function () {
      const lockAdmin = baal.interface.encodeFunctionData("lockAdmin");
      const lockAdminAction = encodeMultiAction(
        multisend,
        [lockAdmin],
        [await baal.getAddress()],
        ['0'],
        [0]
      );

      proposal.data = lockAdminAction;
      proposal.details = 'Admin Locks';

      await baal.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      await baal.submitVote(1, true);
      await moveForwardPeriods(defaultDAOSettings.VOTING_PERIOD_IN_SECONDS, 2);
      await baal.processProposal(1, proposal.data);
      expect(await baal.adminLock()).to.equal(true);
    });

    it("setShamans - 0 - success", async () => {
      const id = await proposalHelpers.setShamanProposal(baal, multisend, users.shaman.address, 0);
      const propStatus = await baal.getProposalStatus(id);
      expect(propStatus).to.eql([false, true, true, false]); // [cancelled, processed, passed, actionFailed]
      expect(await baal.shamans(users.shaman.address)).to.equal(SHAMAN_PERMISSIONS.NONE);
    });

    it("setShamans - 1 - fail", async () => {
      const id = await proposalHelpers.setShamanProposal(baal, multisend, users.shaman.address, SHAMAN_PERMISSIONS.ADMIN);
      const propStatus = await baal.getProposalStatus(id);
      expect(propStatus).to.eql([false, true, true, true]); // [cancelled, processed, passed, actionFailed]
      expect(await baal.shamans(users.shaman.address)).to.equal(SHAMAN_PERMISSIONS.ALL);
    });

    it("setShamans - 2 - success", async () => {
      const id = await proposalHelpers.setShamanProposal(baal, multisend, users.shaman.address, SHAMAN_PERMISSIONS.MANAGER);
      const propStatus = await baal.getProposalStatus(id);
      expect(propStatus).to.eql([false, true, true, false]); // [cancelled, processed, passed, actionFailed]
      expect(await baal.shamans(users.shaman.address)).to.equal(SHAMAN_PERMISSIONS.MANAGER);
    });

    it("setShamans - 3 - fail", async () => {
      const id = await proposalHelpers.setShamanProposal(baal, multisend, users.shaman.address, SHAMAN_PERMISSIONS.ADMIN_MANAGER);
      const propStatus = await baal.getProposalStatus(id);
      expect(propStatus).to.eql([false, true, true, true]); // [cancelled, processed, passed, actionFailed]
      expect(await baal.shamans(users.shaman.address)).to.equal(SHAMAN_PERMISSIONS.ALL);
    });

    it("setShamans - 4 - success", async () => {
      const id = await proposalHelpers.setShamanProposal(baal, multisend, users.shaman.address, SHAMAN_PERMISSIONS.GOVERNANCE);
      const propStatus = await baal.getProposalStatus(id);
      expect(propStatus).to.eql([false, true, true, false]); // [cancelled, processed, passed, actionFailed]
      expect(await baal.shamans(users.shaman.address)).to.equal(SHAMAN_PERMISSIONS.GOVERNANCE);
    });

    it("setShamans - 5 - fail", async () => {
      const id = await proposalHelpers.setShamanProposal(baal, multisend, users.shaman.address, SHAMAN_PERMISSIONS.ADMIN_GOVERNANCE);
      const propStatus = await baal.getProposalStatus(id);
      expect(propStatus).to.eql([false, true, true, true]); // [cancelled, processed, passed, actionFailed]
      expect(await baal.shamans(users.shaman.address)).to.equal(SHAMAN_PERMISSIONS.ALL);
    });

    it("setShamans - 6 - success", async () => {
      const id = await proposalHelpers.setShamanProposal(baal, multisend, users.shaman.address, SHAMAN_PERMISSIONS.MANAGER_GOVERNANCE);
      const propStatus = await baal.getProposalStatus(id);
      expect(propStatus).to.eql([false, true, true, false]); // [cancelled, processed, passed, actionFailed]
      expect(await baal.shamans(users.shaman.address)).to.equal(SHAMAN_PERMISSIONS.MANAGER_GOVERNANCE);
    });

    it("setShamans - 7 - fail", async () => {
      const id = await proposalHelpers.setShamanProposal(baal, multisend, users.summoner.address, SHAMAN_PERMISSIONS.ALL); // use summoner bc shaman default = 7
      const propStatus = await baal.getProposalStatus(id);
      expect(propStatus).to.eql([false, true, true, true]); // [cancelled, processed, passed, actionFailed]
      expect(await baal.shamans(users.summoner.address)).to.equal(SHAMAN_PERMISSIONS.NONE);
    });
  });

  describe("setShamans - managerLock (2, 3, 6, 7)", function () {
    beforeEach(async function () {
      const lockManager = baal.interface.encodeFunctionData(
        "lockManager"
      );
      const lockManagerAction = encodeMultiAction(
        multisend,
        [lockManager],
        [await baal.getAddress()],
        ['0'],
        [0]
      );

      proposal.data = lockManagerAction;
      proposal.details = 'Manager Locks';

      await baal.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      await baal.submitVote(1, true);
      await moveForwardPeriods(defaultDAOSettings.VOTING_PERIOD_IN_SECONDS, 2);
      await baal.processProposal(1, proposal.data);
      expect(await baal.managerLock()).to.equal(true);
    });

    it("setShamans - 0 - success", async () => {
      const id = await proposalHelpers.setShamanProposal(baal, multisend, users.shaman.address, SHAMAN_PERMISSIONS.NONE);
      const propStatus = await baal.getProposalStatus(id);
      expect(propStatus).to.eql([false, true, true, false]); // [cancelled, processed, passed, actionFailed]
      expect(await baal.shamans(users.shaman.address)).to.equal(SHAMAN_PERMISSIONS.NONE);
    });

    it("setShamans - 1 - success", async () => {
      const id = await proposalHelpers.setShamanProposal(baal, multisend, users.shaman.address, SHAMAN_PERMISSIONS.ADMIN);
      const propStatus = await baal.getProposalStatus(id);
      expect(propStatus).to.eql([false, true, true, false]); // [cancelled, processed, passed, actionFailed]
      expect(await baal.shamans(users.shaman.address)).to.equal(SHAMAN_PERMISSIONS.ADMIN);
    });

    it("setShamans - 2 - fail", async () => {
      const id = await proposalHelpers.setShamanProposal(baal, multisend, users.shaman.address, SHAMAN_PERMISSIONS.MANAGER);
      const propStatus = await baal.getProposalStatus(id);
      expect(propStatus).to.eql([false, true, true, true]); // [cancelled, processed, passed, actionFailed]
      expect(await baal.shamans(users.shaman.address)).to.equal(SHAMAN_PERMISSIONS.ALL);
    });

    it("setShamans - 3 - fail", async () => {
      const id = await proposalHelpers.setShamanProposal(baal, multisend, users.shaman.address, SHAMAN_PERMISSIONS.ADMIN_MANAGER);
      const propStatus = await baal.getProposalStatus(id);
      expect(propStatus).to.eql([false, true, true, true]); // [cancelled, processed, passed, actionFailed]
      expect(await baal.shamans(users.shaman.address)).to.equal(SHAMAN_PERMISSIONS.ALL);
    });

    it("setShamans - 4 - success", async () => {
      const id = await proposalHelpers.setShamanProposal(baal, multisend, users.shaman.address, SHAMAN_PERMISSIONS.GOVERNANCE);
      const propStatus = await baal.getProposalStatus(id);
      expect(propStatus).to.eql([false, true, true, false]); // [cancelled, processed, passed, actionFailed]
      expect(await baal.shamans(users.shaman.address)).to.equal(SHAMAN_PERMISSIONS.GOVERNANCE);
    });

    it("setShamans - 5 - success", async () => {
      const id = await proposalHelpers.setShamanProposal(baal, multisend, users.shaman.address, SHAMAN_PERMISSIONS.ADMIN_GOVERNANCE);
      const propStatus = await baal.getProposalStatus(id);
      expect(propStatus).to.eql([false, true, true, false]); // [cancelled, processed, passed, actionFailed]
      expect(await baal.shamans(users.shaman.address)).to.equal(SHAMAN_PERMISSIONS.ADMIN_GOVERNANCE);
    });

    it("setShamans - 6 - fail", async () => {
      const id = await proposalHelpers.setShamanProposal(baal, multisend, users.shaman.address, SHAMAN_PERMISSIONS.MANAGER_GOVERNANCE);
      const propStatus = await baal.getProposalStatus(id);
      expect(propStatus).to.eql([false, true, true, true]); // [cancelled, processed, passed, actionFailed]
      expect(await baal.shamans(users.shaman.address)).to.equal(SHAMAN_PERMISSIONS.ALL);
    });

    it("setShamans - 7 - fail", async () => {
      const id = await proposalHelpers.setShamanProposal(baal, multisend, users.summoner.address, SHAMAN_PERMISSIONS.ALL); // use summoner bc shaman default = 7
      const propStatus = await baal.getProposalStatus(id);
      expect(propStatus).to.eql([false, true, true, true]); // [cancelled, processed, passed, actionFailed]
      expect(await baal.shamans(users.summoner.address)).to.equal(SHAMAN_PERMISSIONS.NONE);
    });
  });

  describe("setShamans - governorLock (4, 5, 6, 7)", function () {
    beforeEach(async function () {
      const lockGovernor = baal.interface.encodeFunctionData(
        "lockGovernor"
      );
      const lockGovernorAction = encodeMultiAction(
        multisend,
        [lockGovernor],
        [await baal.getAddress()],
        ['0'],
        [0]
      );

      proposal.data = lockGovernorAction;
      proposal.details = 'Governor Locks';

      await baal.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      await baal.submitVote(1, true);
      await moveForwardPeriods(defaultDAOSettings.VOTING_PERIOD_IN_SECONDS, 2);
      await baal.processProposal(1, proposal.data);
      expect(await baal.governorLock()).to.equal(true);
    });

    it("setShamans - 0 - success", async () => {
      const id = await proposalHelpers.setShamanProposal(baal, multisend, users.shaman.address, SHAMAN_PERMISSIONS.NONE);
      const propStatus = await baal.getProposalStatus(id);
      expect(propStatus).to.eql([false, true, true, false]); // [cancelled, processed, passed, actionFailed]
      expect(await baal.shamans(users.shaman.address)).to.equal(SHAMAN_PERMISSIONS.NONE);
    });

    it("setShamans - 1 - success", async () => {
      const id = await proposalHelpers.setShamanProposal(baal, multisend, users.shaman.address, SHAMAN_PERMISSIONS.ADMIN);
      const propStatus = await baal.getProposalStatus(id);
      expect(propStatus).to.eql([false, true, true, false]); // [cancelled, processed, passed, actionFailed]
      expect(await baal.shamans(users.shaman.address)).to.equal(SHAMAN_PERMISSIONS.ADMIN);
    });

    it("setShamans - 2 - success", async () => {
      const id = await proposalHelpers.setShamanProposal(baal, multisend, users.shaman.address, SHAMAN_PERMISSIONS.MANAGER);
      const propStatus = await baal.getProposalStatus(id);
      expect(propStatus).to.eql([false, true, true, false]); // [cancelled, processed, passed, actionFailed]
      expect(await baal.shamans(users.shaman.address)).to.equal(SHAMAN_PERMISSIONS.MANAGER);
    });

    it("setShamans - 3 - success", async () => {
      const id = await proposalHelpers.setShamanProposal(baal, multisend, users.shaman.address, SHAMAN_PERMISSIONS.ADMIN_MANAGER);
      const propStatus = await baal.getProposalStatus(id);
      expect(propStatus).to.eql([false, true, true, false]); // [cancelled, processed, passed, actionFailed]
      expect(await baal.shamans(users.shaman.address)).to.equal(SHAMAN_PERMISSIONS.ADMIN_MANAGER);
    });

    it("setShamans - 4 - fail", async () => {
      const id = await proposalHelpers.setShamanProposal(baal, multisend, users.shaman.address, SHAMAN_PERMISSIONS.GOVERNANCE);
      const propStatus = await baal.getProposalStatus(id);
      expect(propStatus).to.eql([false, true, true, true]); // [cancelled, processed, passed, actionFailed]
      expect(await baal.shamans(users.shaman.address)).to.equal(SHAMAN_PERMISSIONS.ALL);
    });

    it("setShamans - 5 - fail", async () => {
      const id = await proposalHelpers.setShamanProposal(baal, multisend, users.shaman.address, SHAMAN_PERMISSIONS.ADMIN_GOVERNANCE);
      const propStatus = await baal.getProposalStatus(id);
      expect(propStatus).to.eql([false, true, true, true]); // [cancelled, processed, passed, actionFailed]
      expect(await baal.shamans(users.shaman.address)).to.equal(SHAMAN_PERMISSIONS.ALL);
    });

    it("setShamans - 6 - fail", async () => {
      const id = await proposalHelpers.setShamanProposal(baal, multisend, users.shaman.address, SHAMAN_PERMISSIONS.MANAGER_GOVERNANCE);
      const propStatus = await baal.getProposalStatus(id);
      expect(propStatus).to.eql([false, true, true, true]); // [cancelled, processed, passed, actionFailed]
      expect(await baal.shamans(users.shaman.address)).to.equal(SHAMAN_PERMISSIONS.ALL);
    });

    it("setShamans - 7 - fail", async () => {
      const id = await proposalHelpers.setShamanProposal(baal, multisend, users.summoner.address, SHAMAN_PERMISSIONS.ALL); // use summoner bc shaman default = 7
      const propStatus = await baal.getProposalStatus(id);
      expect(propStatus).to.eql([false, true, true, true]); // [cancelled, processed, passed, actionFailed]
      expect(await baal.shamans(users.summoner.address)).to.equal(SHAMAN_PERMISSIONS.NONE);
    });
  });

  describe("setShamans - all locked", function () {
    beforeEach(async function () {
      const lockAdmin = baal.interface.encodeFunctionData("lockAdmin");
      const lockManager = baal.interface.encodeFunctionData(
        "lockManager"
      );
      const lockGovernor = baal.interface.encodeFunctionData(
        "lockGovernor"
      );
      const lockAllAction = encodeMultiAction(
        multisend,
        [lockAdmin, lockManager, lockGovernor],
        [await baal.getAddress(), await baal.getAddress(), await baal.getAddress()],
        ['0', '0', '0'],
        [0, 0, 0]
      );

      proposal.data = lockAllAction;
      proposal.details = 'Locks All';

      await baal.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      await baal.submitVote(1, true);
      await moveForwardPeriods(defaultDAOSettings.VOTING_PERIOD_IN_SECONDS, 2);
      await baal.processProposal(1, proposal.data);
      expect(await baal.adminLock()).to.equal(true);
      expect(await baal.managerLock()).to.equal(true);
      expect(await baal.governorLock()).to.equal(true);
    });

    it("setShamans - 0 - success", async () => {
      const id = await proposalHelpers.setShamanProposal(baal, multisend, users.shaman.address, SHAMAN_PERMISSIONS.NONE);
      const propStatus = await baal.getProposalStatus(id);
      expect(propStatus).to.eql([false, true, true, false]); // [cancelled, processed, passed, actionFailed]
      expect(await baal.shamans(users.shaman.address)).to.equal(SHAMAN_PERMISSIONS.NONE);
    });

    it("setShamans - 1 - fail", async () => {
      const id = await proposalHelpers.setShamanProposal(baal, multisend, users.shaman.address, SHAMAN_PERMISSIONS.ADMIN);
      const propStatus = await baal.getProposalStatus(id);
      expect(propStatus).to.eql([false, true, true, true]); // [cancelled, processed, passed, actionFailed]
      expect(await baal.shamans(users.shaman.address)).to.equal(SHAMAN_PERMISSIONS.ALL);
    });

    it("setShamans - 2 - fail", async () => {
      const id = await proposalHelpers.setShamanProposal(baal, multisend, users.shaman.address, SHAMAN_PERMISSIONS.MANAGER);
      const propStatus = await baal.getProposalStatus(id);
      expect(propStatus).to.eql([false, true, true, true]); // [cancelled, processed, passed, actionFailed]
      expect(await baal.shamans(users.shaman.address)).to.equal(SHAMAN_PERMISSIONS.ALL);
    });

    it("setShamans - 3 - fail", async () => {
      const id = await proposalHelpers.setShamanProposal(baal, multisend, users.shaman.address, SHAMAN_PERMISSIONS.ADMIN_MANAGER);
      const propStatus = await baal.getProposalStatus(id);
      expect(propStatus).to.eql([false, true, true, true]); // [cancelled, processed, passed, actionFailed]
      expect(await baal.shamans(users.shaman.address)).to.equal(SHAMAN_PERMISSIONS.ALL);
    });

    it("setShamans - 4 - fail", async () => {
      const id = await proposalHelpers.setShamanProposal(baal, multisend, users.shaman.address, SHAMAN_PERMISSIONS.GOVERNANCE);
      const propStatus = await baal.getProposalStatus(id);
      expect(propStatus).to.eql([false, true, true, true]); // [cancelled, processed, passed, actionFailed]
      expect(await baal.shamans(users.shaman.address)).to.equal(SHAMAN_PERMISSIONS.ALL);
    });

    it("setShamans - 5 - fail", async () => {
      const id = await proposalHelpers.setShamanProposal(baal, multisend, users.shaman.address, SHAMAN_PERMISSIONS.ADMIN_GOVERNANCE);
      const propStatus = await baal.getProposalStatus(id);
      expect(propStatus).to.eql([false, true, true, true]); // [cancelled, processed, passed, actionFailed]
      expect(await baal.shamans(users.shaman.address)).to.equal(SHAMAN_PERMISSIONS.ALL);
    });

    it("setShamans - 6 - fail", async () => {
      const id = await proposalHelpers.setShamanProposal(baal, multisend, users.shaman.address, SHAMAN_PERMISSIONS.MANAGER_GOVERNANCE);
      const propStatus = await baal.getProposalStatus(id);
      expect(propStatus).to.eql([false, true, true, true]); // [cancelled, processed, passed, actionFailed]
      expect(await baal.shamans(users.shaman.address)).to.equal(SHAMAN_PERMISSIONS.ALL);
    });

    it("setShamans - 7 - fail", async () => {
      const id = await proposalHelpers.setShamanProposal(baal, multisend, users.summoner.address, SHAMAN_PERMISSIONS.ALL); // use summoner bc shaman default = 7
      const propStatus = await baal.getProposalStatus(id);
      expect(propStatus).to.eql([false, true, true, true]); // [cancelled, processed, passed, actionFailed]
      expect(await baal.shamans(users.summoner.address)).to.equal(SHAMAN_PERMISSIONS.NONE);
    });
  });

  // -----------------------------------------------------------
  // ------------------ SHARES ---------------------------------
  // -----------------------------------------------------------

  describe("erc20 shares - approve", function () {
    const amountToApprove = 20;

    it("happy case", async () => {
      await users.summoner.shares?.approve(users.shaman.address, amountToApprove);
      const allowance = await sharesToken.allowance(
        users.summoner.address,
        users.shaman.address
      );
      expect(allowance).to.equal(amountToApprove);
    });

    it("overwrites previous value", async () => {
      await users.summoner.shares?.approve(users.shaman.address, amountToApprove);
      const allowance = await sharesToken.allowance(
        users.summoner.address,
        users.shaman.address
      );
      expect(allowance).to.equal(amountToApprove);

      await users.summoner.shares?.approve(users.shaman.address, 50);
      const allowance2 = await sharesToken.allowance(
        users.summoner.address,
        users.shaman.address
      );
      expect(allowance2).to.equal(50);
    });
  });

  describe("erc20 shares - transfer", function () {

    it("transfer to first time recipient - auto self delegates", async () => {
      await users.summoner.shares?.transfer(
        users.shaman.address,
        deploymentConfig.SPONSOR_THRESHOLD
      );

      const summonerBalance = await sharesToken.balanceOf(users.summoner.address);
      const summonerVotes = await sharesToken.getVotes(users.summoner.address);
      const shamanBalance = await sharesToken.balanceOf(users.shaman.address);
      const shamanVotes = await sharesToken.getVotes(users.shaman.address);
      expect(summonerBalance).to.equal(users.summoner.sharesInitial - deploymentConfig.SPONSOR_THRESHOLD);
      expect(summonerVotes).to.equal(users.summoner.sharesInitial - deploymentConfig.SPONSOR_THRESHOLD);
      expect(shamanBalance).to.equal(deploymentConfig.SPONSOR_THRESHOLD);
      expect(shamanVotes).to.equal(deploymentConfig.SPONSOR_THRESHOLD);

      const summonerCheckpoints = await sharesToken.numCheckpoints(
        users.summoner.address
      );
      const shamanCheckpoints = await sharesToken.numCheckpoints(
        users.shaman.address
      );
      const summonerCP0 = await sharesToken.checkpoints(users.summoner.address, 0);
      const summonerCP1 = await sharesToken.checkpoints(users.summoner.address, 1);
      const shamanCP0 = await sharesToken.checkpoints(users.shaman.address, 0);
      const shamanCP1 = await sharesToken.checkpoints(users.shaman.address, 1);
      expect(summonerCheckpoints).to.equal(2);
      expect(shamanCheckpoints).to.equal(1);
      expect(summonerCP0.votes).to.equal(users.summoner.sharesInitial);
      expect(summonerCP1.votes).to.equal(users.summoner.sharesInitial - deploymentConfig.SPONSOR_THRESHOLD);
      expect(shamanCP0.votes).to.equal(1);
      expect(shamanCP1.fromTimePoint).to.equal(0); // checkpoint DNE

      const delegate = await sharesToken.delegates(users.shaman.address);
      expect(delegate).to.equal(users.shaman.address);
    });

    it("require fails - shares paused", async () => {
      await users.shaman.baal?.setAdminConfig(true, false); // pause shares
      await expect(
        users.summoner.shares?.transfer(users.shaman.address, deploymentConfig.SPONSOR_THRESHOLD)
      ).to.be.revertedWith(revertMessages.sharesTransferPaused);
    });

    it("require fails - insufficient balance", async () => {
      await expect(
        users.summoner.shares?.transfer(users.shaman.address, users.summoner.sharesInitial + 1)
      ).to.be.revertedWith(revertMessages.sharesInsufficientBalance);
    });

    it("0 transfer - doesnt update delegates", async () => {
      await users.summoner.shares?.transfer(users.shaman.address, 0);
      const summonerBalance = await sharesToken.balanceOf(users.summoner.address);
      const summonerVotes = await sharesToken.getVotes(users.summoner.address);
      const shamanBalance = await sharesToken.balanceOf(users.shaman.address);
      const shamanVotes = await sharesToken.getVotes(users.shaman.address);
      expect(summonerBalance).to.equal(users.summoner.sharesInitial);
      expect(summonerVotes).to.equal(users.summoner.sharesInitial);
      expect(shamanBalance).to.equal(0);
      expect(shamanVotes).to.equal(0);

      const summonerCheckpoints = await sharesToken.numCheckpoints(
        users.summoner.address
      );
      const shamanCheckpoints = await sharesToken.numCheckpoints(
        users.shaman.address
      );
      const summonerCP0 = await sharesToken.checkpoints(users.summoner.address, 0);
      const shamanCP0 = await sharesToken.checkpoints(users.shaman.address, 0);
      expect(summonerCheckpoints).to.equal(1);
      expect(shamanCheckpoints).to.equal(0);
      expect(summonerCP0.votes).to.equal(users.summoner.sharesInitial);
      expect(shamanCP0.fromTimePoint).to.equal(0); // checkpoint DNE
    });

    it("self transfer - doesnt update delegates", async () => {
      await users.summoner.shares?.transfer(users.summoner.address, 10);
      const summonerBalance = await sharesToken.balanceOf(users.summoner.address);
      const summonerVotes = await sharesToken.getVotes(users.summoner.address);
      expect(summonerBalance).to.equal(users.summoner.sharesInitial);
      expect(summonerVotes).to.equal(users.summoner.sharesInitial);

      const summonerCheckpoints = await sharesToken.numCheckpoints(
        users.summoner.address
      );
      const summonerCP0 = await sharesToken.checkpoints(users.summoner.address, 0);
      expect(summonerCheckpoints).to.equal(1);
      expect(summonerCP0.votes).to.equal(users.summoner.sharesInitial);
    });

    it("transferring to shareholder w/ delegate assigns votes to delegate", async () => {
      await users.summoner.shares?.transfer(
        users.shaman.address,
        deploymentConfig.SPONSOR_THRESHOLD
      );
      await users.shaman.shares?.delegate(users.applicant.address); // set shaman delegate -> applicant
      await users.summoner.shares?.transfer(
        users.shaman.address,
        deploymentConfig.SPONSOR_THRESHOLD
      );

      const summonerBalance = await sharesToken.balanceOf(users.summoner.address);
      const summonerVotes = await sharesToken.getVotes(users.summoner.address);
      const shamanBalance = await sharesToken.balanceOf(users.shaman.address);
      const shamanVotes = await sharesToken.getVotes(users.shaman.address);
      const applicantBalance = await sharesToken.balanceOf(users.applicant.address);
      const applicantVotes = await sharesToken.getVotes(users.applicant.address);
      expect(summonerBalance).to.equal(users.summoner.sharesInitial - 2 * deploymentConfig.SPONSOR_THRESHOLD);
      expect(summonerVotes).to.equal(users.summoner.sharesInitial - 2 * deploymentConfig.SPONSOR_THRESHOLD);
      expect(shamanBalance).to.equal(2 * deploymentConfig.SPONSOR_THRESHOLD);
      expect(shamanVotes).to.equal(0);
      expect(applicantBalance).to.equal(defaultSummonSetup.shares);
      expect(applicantVotes).to.equal(defaultSummonSetup.shares + 2 * deploymentConfig.SPONSOR_THRESHOLD);

      const delegate = await sharesToken.delegates(users.shaman.address);
      expect(delegate).to.equal(users.applicant.address);

      const summonerCheckpoints = await sharesToken.numCheckpoints(
        users.summoner.address
      );
      const shamanCheckpoints = await sharesToken.numCheckpoints(
        users.shaman.address
      );
      const applicantCheckpoints = await sharesToken.numCheckpoints(
        users.applicant.address
      );
      const summonerCP0 = await sharesToken.checkpoints(users.summoner.address, 0);
      const summonerCP1 = await sharesToken.checkpoints(users.summoner.address, 1);
      const summonerCP2 = await sharesToken.checkpoints(users.summoner.address, 2);
      const shamanCP0 = await sharesToken.checkpoints(users.shaman.address, 0);
      const shamanCP1 = await sharesToken.checkpoints(users.shaman.address, 1);
      const applicantCP0 = await sharesToken.checkpoints(users.applicant.address, 0);
      const applicantCP1 = await sharesToken.checkpoints(users.applicant.address, 1);
      const applicantCP2 = await sharesToken.checkpoints(users.applicant.address, 2);
      expect(summonerCheckpoints).to.equal(3);
      expect(shamanCheckpoints).to.equal(2);
      expect(applicantCheckpoints).to.equal(3);
      expect(summonerCP0.votes).to.equal(users.summoner.sharesInitial);
      expect(summonerCP1.votes).to.equal(users.summoner.sharesInitial - deploymentConfig.SPONSOR_THRESHOLD);
      expect(summonerCP2.votes).to.equal(users.summoner.sharesInitial - 2 * deploymentConfig.SPONSOR_THRESHOLD);
      expect(shamanCP0.votes).to.equal(deploymentConfig.SPONSOR_THRESHOLD);
      expect(shamanCP1.votes).to.equal(0);
      expect(applicantCP0.votes).to.equal(defaultSummonSetup.shares);
      expect(applicantCP1.votes).to.equal(defaultSummonSetup.shares + deploymentConfig.SPONSOR_THRESHOLD);
      expect(applicantCP2.votes).to.equal(defaultSummonSetup.shares + 2 * deploymentConfig.SPONSOR_THRESHOLD);
    });
  });

  describe("erc20 shares - transferFrom", function () {
    it("transfer to first time recipient", async () => {
      await users.summoner.shares?.approve(
        users.shaman.address,
        deploymentConfig.SPONSOR_THRESHOLD
      );

      const allowanceBefore = await sharesToken.allowance(
        users.summoner.address,
        users.shaman.address
      );
      expect(allowanceBefore).to.equal(1);

      await users.shaman.shares?.transferFrom(
        users.summoner.address,
        users.shaman.address,
        deploymentConfig.SPONSOR_THRESHOLD
      );

      const allowanceAfter = await sharesToken.allowance(
        users.summoner.address,
        users.shaman.address
      );
      expect(allowanceAfter).to.equal(0);

      const summonerBalance = await sharesToken.balanceOf(users.summoner.address);
      const summonerVotes = await sharesToken.getVotes(users.summoner.address);
      const shamanBalance = await sharesToken.balanceOf(users.shaman.address);
      const shamanVotes = await sharesToken.getVotes(users.shaman.address);
      expect(summonerBalance).to.equal(users.summoner.sharesInitial - deploymentConfig.SPONSOR_THRESHOLD);
      expect(summonerVotes).to.equal(users.summoner.sharesInitial - deploymentConfig.SPONSOR_THRESHOLD);
      expect(shamanBalance).to.equal(deploymentConfig.SPONSOR_THRESHOLD);
      expect(shamanVotes).to.equal(deploymentConfig.SPONSOR_THRESHOLD);

      const summonerCheckpoints = await sharesToken.numCheckpoints(
        users.summoner.address
      );
      const shamanCheckpoints = await sharesToken.numCheckpoints(
        users.shaman.address
      );
      const summonerCP0 = await sharesToken.checkpoints(users.summoner.address, 0);
      const summonerCP1 = await sharesToken.checkpoints(users.summoner.address, 1);
      const shamanCP0 = await sharesToken.checkpoints(users.shaman.address, 0);
      const shamanCP1 = await sharesToken.checkpoints(users.shaman.address, 1);
      expect(summonerCheckpoints).to.equal(2);
      expect(shamanCheckpoints).to.equal(1);
      expect(summonerCP0.votes).to.equal(users.summoner.sharesInitial);
      expect(summonerCP1.votes).to.equal(users.summoner.sharesInitial - deploymentConfig.SPONSOR_THRESHOLD);
      expect(shamanCP0.votes).to.equal(deploymentConfig.SPONSOR_THRESHOLD);
      expect(shamanCP1.fromTimePoint).to.equal(0); // checkpoint DNE
    });

    it("require fails - shares paused", async () => {
      await users.shaman.baal?.setAdminConfig(true, false); // pause shares
      await users.shaman.shares?.approve(
        users.summoner.address,
        deploymentConfig.SPONSOR_THRESHOLD
      );
      await expect(
        users.summoner.shares?.transferFrom(
          users.shaman.address,
          users.summoner.address,
          deploymentConfig.SPONSOR_THRESHOLD
        )
      ).to.be.revertedWith(revertMessages.sharesTransferPaused);
    });

    it("require fails - insufficeint approval", async () => {
      await sharesToken.approve(users.shaman.address, 1);

      await expect(
        sharesToken.transferFrom(users.summoner.address, users.shaman.address, 2)
      ).to.be.revertedWith(revertMessages.sharesInsufficientApproval);
    });
  });

  // -----------------------------------------------------------
  // ------------------ LOOT -----------------------------------
  // -----------------------------------------------------------

  describe("erc20 loot - approve", function () {
    const amountToTransfer = 20;

    it("happy case", async () => {
      await users.summoner.loot?.approve(users.shaman.address, amountToTransfer);
      const allowance = await lootToken.allowance(
        users.summoner.address,
        users.shaman.address
      );
      expect(allowance).to.equal(amountToTransfer);
    });

    it("overwrites previous value", async () => {
      await users.summoner.loot?.approve(users.shaman.address, amountToTransfer);
      const allowance = await lootToken.allowance(
        users.summoner.address,
        users.shaman.address
      );
      expect(allowance).to.equal(amountToTransfer);

      await users.summoner.loot?.approve(users.shaman.address, 50);
      const allowance2 = await lootToken.allowance(
        users.summoner.address,
        users.shaman.address
      );
      expect(allowance2).to.equal(50);
    });
  });

  describe("erc20 loot - transfer", function () {
    const amountToTransfer = 500;
    it("sends tokens, not votes", async () => {
      await users.summoner.loot?.transfer(users.shaman.address, amountToTransfer);
      const summonerBalance = await lootToken.balanceOf(users.summoner.address);
      const summonerVotes = await sharesToken.getVotes(users.summoner.address);
      const shamanBalance = await lootToken.balanceOf(users.shaman.address);
      const shamanVotes = await sharesToken.getVotes(users.shaman.address);
      expect(summonerBalance).to.equal(defaultSummonSetup.loot - amountToTransfer);
      expect(summonerVotes).to.equal(users.summoner.sharesInitial);
      expect(shamanBalance).to.equal(amountToTransfer);
      expect(shamanVotes).to.equal(0);
    });

    it("require fails - loot paused", async () => {
      await users.shaman.baal?.setAdminConfig(false, true); // pause loot
      await expect(users.summoner.loot?.transfer(users.shaman.address, 1)).to.be.revertedWith(
        revertMessages.lootTransferPaused
      );
    });

    it("require fails - insufficient balance", async () => {
      await expect(lootToken.transfer(users.shaman.address, 501)).to.be.revertedWith(
        revertMessages.lootInsufficientBalance
      );
    });
  });

  describe("erc20 loot - transferFrom", function () {
    const amountToTransfer = 500;

    it("sends tokens, not votes", async () => {
      await users.summoner.loot?.approve(users.shaman.address, amountToTransfer);
      await users.shaman.loot?.transferFrom(users.summoner.address, users.shaman.address, amountToTransfer);
      const summonerBalance = await lootToken.balanceOf(users.summoner.address);
      const summonerVotes = await sharesToken.getVotes(users.summoner.address);
      const shamanBalance = await lootToken.balanceOf(users.shaman.address);
      const shamanVotes = await sharesToken.getVotes(users.shaman.address);
      expect(summonerBalance).to.equal(0);
      expect(summonerVotes).to.equal(users.summoner.sharesInitial);
      expect(shamanBalance).to.equal(amountToTransfer);
      expect(shamanVotes).to.equal(0);
    });

    it("require fails - loot paused", async () => {
      await users.shaman.baal?.setAdminConfig(false, true); // pause loot
      await users.summoner.loot?.approve(users.shaman.address, amountToTransfer);
      await expect(
        users.shaman.loot?.transferFrom(users.summoner.address, users.shaman.address, amountToTransfer)
      ).to.be.revertedWith(revertMessages.lootTransferPaused);
    });

    it("require fails - insufficient balance", async () => {
      const toTransfer = defaultSummonSetup.loot + 1
      await users.summoner.loot?.approve(users.shaman.address, toTransfer);
      await expect(
        users.shaman.loot?.transferFrom(users.summoner.address, users.shaman.address, toTransfer)
      ).to.be.revertedWith(revertMessages.lootInsufficientBalance);
    });

    it("require fails - insufficeint approval", async () => {
      await users.summoner.loot?.approve(users.shaman.address, defaultSummonSetup.loot - 1);
      await expect(
        users.shaman.loot?.transferFrom(users.summoner.address, users.shaman.address, defaultSummonSetup.loot)
      ).to.be.revertedWith(revertMessages.lootInsufficientApproval);
    });
  });

  // -----------------------------------------------------------
  // ------------------ PROPOSALS ------------------------------
  // -----------------------------------------------------------

  describe("submitProposal", function () {
    it("happy case", async () => {
      // note - this also tests that members can submit proposals without offering tribute
      // note - this also tests that member proposals are self-sponsored (bc votingStarts != 0)
      const countBefore = await baal.proposalCount();

      await users.summoner.baal?.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      // TODO test return value - use a helper contract to submit + save the returned ID

      const now = await blockTime();

      const countAfter = await baal.proposalCount();
      expect(countAfter).to.equal(BigInt(countBefore) + BigInt(1));

      const state = await baal.state(1);
      expect(state).to.equal(PROPOSAL_STATES.VOTING);

      const proposalData = await baal.proposals(1);
      expect(proposalData.id).to.equal(BigInt(1));
      expect(proposalData.votingStarts).to.equal(now);
      expect(proposalData.votingEnds).to.equal(
        now + deploymentConfig.VOTING_PERIOD_IN_SECONDS
      );
      expect(proposalData.yesVotes).to.equal(0);
      expect(proposalData.noVotes).to.equal(0);
      expect(proposalData.expiration).to.equal(proposal.expiration);
      expect(hashOperation(proposal.data)).to.equal(
        proposalData.proposalDataHash
      );
      const proposalStatus = await baal.getProposalStatus(1);
      expect(proposalStatus).to.eql([false, false, false, false]);
    });

    it("require fail - expiration passed", async () => {
      const now = await blockTime();

      await expect(
        baal.submitProposal(
          proposal.data,
          now,
          proposal.baalGas,
          ethers.id(proposal.details)
        )
      ).to.be.revertedWith(revertMessages.submitProposalExpired);
    });

    it("edge case - expiration exists, but far enough ahead", async () => {
      const countBefore = await baal.proposalCount();
      const expiration =
        (await blockTime()) +
        deploymentConfig.VOTING_PERIOD_IN_SECONDS +
        deploymentConfig.GRACE_PERIOD_IN_SECONDS +
        10000;
      await users.summoner.baal?.submitProposal(
        proposal.data,
        expiration,
        0,
        ethers.id(proposal.details)
      );

      const countAfter = await baal.proposalCount();
      expect(countAfter).to.equal(BigInt(countBefore) + BigInt(1));

      const proposalData = await baal.proposals(1);
      expect(proposalData.id).to.equal(BigInt(1));
    });
  });

  describe("sponsorProposal", function () {
    it("happy case", async () => {
      await users.shaman.baal?.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );

      const proposalData = await baal.proposals(1);
      expect(proposalData.votingStarts).to.equal(0);
      const state = await baal.state(1);
      expect(state).to.equal(PROPOSAL_STATES.SUBMITTED);

      await users.summoner.baal?.sponsorProposal(1);
      const now = await blockTime();
      const proposalDataSponsored = await baal.proposals(1);
      expect(proposalDataSponsored.votingStarts).to.equal(now);
      expect(proposalDataSponsored.votingEnds).to.equal(
        now + deploymentConfig.VOTING_PERIOD_IN_SECONDS
      );

      const state2 = await baal.state(1);
      expect(state2).to.equal(PROPOSAL_STATES.VOTING);
    });

    it("require fail - proposal expired", async () => {
      const now = await blockTime();

      const expiration =
        now +
        deploymentConfig.VOTING_PERIOD_IN_SECONDS +
        deploymentConfig.GRACE_PERIOD_IN_SECONDS +
        1000;

      await users.shaman.baal?.submitProposal(
        proposal.data,
        expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      await moveForwardPeriods(defaultDAOSettings.VOTING_PERIOD_IN_SECONDS, 2);

      // TODO: fix
      await expect(baal.sponsorProposal(1)).to.be.revertedWith(
        revertMessages.sponsorProposalExpired
      );
    });

    it("edge case - expiration exists, but far enough ahead 2", async () => {
      const now = await blockTime();
      const expiration =
        now +
        deploymentConfig.VOTING_PERIOD_IN_SECONDS +
        deploymentConfig.GRACE_PERIOD_IN_SECONDS +
        100000;
      await baal.submitProposal(
        proposal.data,
        expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );

      const proposalDataSponsored = await baal.proposals(1);
      const now2 = await blockTime();

      expect(proposalDataSponsored.votingStarts).to.equal(now2);
    });

    it("require fail - not sponsor", async () => {
      await users.shaman.baal?.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );

      await expect(users.shaman.baal?.sponsorProposal(1)).to.be.revertedWith(
        revertMessages.proposalNotSponsored
      );
    });

    it("edge case - just enough shares to sponsor", async () => {
      await users.shaman.baal?.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );

      const proposalData = await baal.proposals(1);
      expect(proposalData.votingStarts).to.equal(0);

      await users.summoner.shares?.transfer(
        users.shaman.address,
        deploymentConfig.SPONSOR_THRESHOLD
      );

      await users.shaman.baal?.sponsorProposal(1);
      const now = await blockTime();
      const proposalDataSponsored = await baal.proposals(1);
      expect(proposalDataSponsored.votingStarts).to.equal(now);
    });

    it("require fail - proposal doesnt exist", async () => {
      const state = await baal.state(1);
      expect(state).to.equal(PROPOSAL_STATES.UNBORN);
      await expect(baal.sponsorProposal(1)).to.be.revertedWith(
        revertMessages.sponsorProposalNotSubmitted
      );
    });

    it("require fail - already sponsored", async () => {
      await users.shaman.baal?.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );

      const proposalData = await baal.proposals(1);
      expect(proposalData.votingStarts).to.equal(0);
      await users.summoner.baal?.sponsorProposal(1);
      const state = await baal.state(1);
      expect(state).to.equal(PROPOSAL_STATES.VOTING);
      await expect(users.summoner.baal?.sponsorProposal(1)).to.be.revertedWith(
        revertMessages.sponsorProposalNotSubmitted
      );
    });
  });

  describe("submitVote (w/ auto self-sponsor)", function () {
    beforeEach(async function () {
      await users.summoner.baal?.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
    });

    it("happy case - yes vote", async () => {
      await users.summoner.baal?.submitVote(1, yes);
      const prop = await baal.proposals(1);
      const nCheckpoints = await sharesToken.numCheckpoints(users.summoner.address);
      const votes = (
        await sharesToken.checkpoints(users.summoner.address, nCheckpoints - BigInt(1))
      ).votes;
      const priorVotes = await sharesToken.getPastVotes(
        users.summoner.address,
        prop.votingStarts
      );
      expect(priorVotes).to.equal(votes);
      expect(prop.yesVotes).to.equal(votes);
      expect(prop.maxTotalSharesAndLootAtVote)
        .to.equal(defaultSummonSetup.shares * 3 + defaultSummonSetup.loot * 2);
    });

    it("happy case - no vote", async () => {
      await users.summoner.baal?.submitVote(1, no);
      const prop = await baal.proposals(1);
      const nCheckpoints = await sharesToken.numCheckpoints(users.summoner.address);
      const votes = (
        await sharesToken.checkpoints(users.summoner.address, nCheckpoints - BigInt(1))
      ).votes;
      expect(prop.noVotes).to.equal(votes);
    });

    it("require fail - voting period has ended", async () => {
      await moveForwardPeriods(defaultDAOSettings.VOTING_PERIOD_IN_SECONDS, 2);
      const state = await baal.state(1);
      expect(state).to.equal(PROPOSAL_STATES.DEEFEATED);
      await expect(users.summoner.baal?.submitVote(1, no)).to.be.revertedWith(
        revertMessages.submitVoteNotVoting
      );
    });

    it("require fail - already voted", async () => {
      await users.summoner.baal?.submitVote(1, yes);
      await expect(users.summoner.baal?.submitVote(1, yes)).to.be.revertedWith(
        revertMessages.submitVoteVoted
      );
    });

    it("require fail - not a member", async () => {
      await expect(users.shaman.baal?.submitVote(1, yes)).to.be.revertedWith(
        revertMessages.submitVoteMember
      );
    });

    it("scenario - two yes votes", async () => {
      await users.summoner.baal?.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      ); // p2
      await users.summoner.baal?.submitVote(1, yes);
      await users.summoner.baal?.submitVote(2, yes);
      const prop1 = await baal.proposals(1);
      const votes1 = await sharesToken.getPastVotes(
        users.summoner.address,
        prop1.votingStarts
      );
      expect(prop1.yesVotes).to.equal(votes1);

      const prop2 = await baal.proposals(2);
      const votes2 = await sharesToken.getPastVotes(
        users.summoner.address,
        prop2.votingStarts
      );
      expect(prop2.yesVotes).to.equal(votes2);
    });
  });

  describe("submitVote (no self-sponsor)", function () {
    const amountToMint = 100;
    const currentShares = defaultSummonSetup.shares * 3;
    const currentLoot = defaultSummonSetup.loot * 2;

    it("require fail - voting not started", async () => {
      await users.shaman.baal?.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      const state = await baal.state(1);
      expect(state).to.equal(PROPOSAL_STATES.SUBMITTED);
      await expect(users.summoner.baal?.submitVote(1, no)).to.be.revertedWith(
        revertMessages.submitVoteNotVoting
      );
    });

    it("scenario - increase shares during voting", async () => {
      await users.shaman.baal?.mintShares([users.shaman.address], [amountToMint]); // shares for shaman
      await users.shaman.baal?.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      await users.summoner.baal?.submitVote(1, yes);
      const prop1 = await baal.proposals(BigInt(1));
      expect(prop1.maxTotalSharesAndLootAtVote).to.equal(
        BigInt(currentShares)
        + BigInt(currentLoot)
        + BigInt(amountToMint)
      );
      await users.shaman.baal?.mintShares([users.shaman.address], [BigInt(amountToMint)]); // add another 100 shares for shaman
      await users.shaman.baal?.submitVote(1, yes);
      const prop = await baal.proposals(1);
      expect(prop.yesVotes).to.equal(BigInt(users.summoner.sharesInitial) + BigInt(amountToMint)); // summoner shares and 1st shares from shaman are counted
      expect(prop.maxTotalSharesAndLootAtVote).to.equal(
        BigInt(currentShares)
        + BigInt(currentLoot)
        + (BigInt(2) * BigInt(amountToMint))
      );
    });

    it("scenario - decrease shares during voting", async () => {
      await users.shaman.baal?.mintShares([users.shaman.address], [amountToMint]); // shares for shaman
      await users.shaman.baal?.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      await users.summoner.baal?.submitVote(1, yes);
      const prop1 = await baal.proposals(1);
      expect(prop1.maxTotalSharesAndLootAtVote).to.equal(
        BigInt(currentShares)
        + BigInt(currentLoot)
        + BigInt(amountToMint)
      );
      await users.shaman.baal?.ragequit(users.shaman.address, BigInt(amountToMint) / BigInt(2), 0, [await weth.getAddress()]);
      await users.shaman.baal?.submitVote(1, yes);
      const prop = await baal.proposals(1);
      expect(prop.yesVotes).to.equal(
        BigInt(users.summoner.sharesInitial) + BigInt(amountToMint)
      ); // summoner votes and initial votes from shaman are counted (not affected by rq)
      expect(prop.maxTotalSharesAndLootAtVote).to.equal(
        BigInt(currentShares)
        + BigInt(currentLoot)
        + BigInt(amountToMint)
      ); // unchanged
    });
  });

  describe("submitVoteWithSig (w/ auto self-sponsor)", function () {
    let signer: SignerWithAddress;
    beforeEach(async function () {
      await baal.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );

      // @ts-expect-error
      signer = await ethers.getSigner(users.summoner.address);
    });

    it("happy case - yes vote", async () => {
      const expiry = await blockTime() + 1200;
      const signature = await signVote(
        chainId,
        await baal.getAddress(),
        signer,
        await sharesToken.name(),
        expiry,
        0,
        1,
        true
      );

      const { v, r, s } = ethers.Signature.from(signature);
      await baal.submitVoteWithSig(signer.address, expiry, 0, 1, true, v, r, s);
      const prop = await baal.proposals(1);
      const nCheckpoints = await sharesToken.numCheckpoints(signer.address);
      const votes = (
        await sharesToken.checkpoints(signer.address, nCheckpoints - BigInt(1))
      ).votes;
      const priorVotes = await sharesToken.getPastVotes(
        signer.address,
        prop.votingStarts
      );
      expect(await baal.votingNonces(signer.address)).to.equal(1);
      expect(priorVotes).to.equal(votes);
      expect(prop.yesVotes).to.equal(votes);
    });


    it("fail case - fails with different voter", async () => {
      const expiry = await blockTime() + 1200;
      const signature = await signVote(
        chainId,
        await baal.getAddress(),
        signer,
        await sharesToken.name(),
        expiry,
        0,
        1,
        true
      );

      const { v, r, s } = ethers.Signature.from(signature);
      expect(
        baal.submitVoteWithSig(users.applicant.address, expiry, 0, 1, true, v, r, s)
      ).to.be.revertedWith("invalid signature");
      expect(await baal.votingNonces(users.applicant.address)).to.equal(0);
    });

    it("fail case - cant vote twice", async () => {
      const expiry = await blockTime() + 1200;
      const signature = await signVote(
        chainId,
        await baal.getAddress(),
        signer,
        await sharesToken.name(),
        expiry,
        0,
        1,
        true
      );

      const { v, r, s } = ethers.Signature.from(signature);
      await baal.submitVoteWithSig(signer.address, expiry, 0, 1, true, v, r, s);

      const signatureTwo = await signVote(
        chainId,
        await baal.getAddress(),
        signer,
        deploymentConfig.TOKEN_NAME,
        expiry,
        1,
        1,
        true
      );
      const sigTwo = ethers.Signature.from(signatureTwo);
      expect(
        baal.submitVoteWithSig(signer.address, expiry, 1, 1, true, sigTwo.v, sigTwo.r, sigTwo.s)
      ).to.be.revertedWith("voted");
      expect(await baal.votingNonces(signer.address)).to.equal(1);
    });
  });

  describe("delegateBySig", function () {
    let signer: SignerWithAddress;

    beforeEach(async function () {
      await baal.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      // @ts-expect-error
      signer = await ethers.getSigner(users.summoner.address);
    });

    it("happy case ", async () => {
      const expiry = (await blockTime()) + 10000;
      const nonce = 0;
      const signature = await signDelegation(
        chainId,
        await sharesToken.getAddress(),
        signer,
        await sharesToken.name(),
        users.shaman.address,
        nonce,
        expiry
      );

      const { v, r, s } = ethers.Signature.from(signature);
      await users.shaman.shares?.delegateBySig(users.shaman.address, nonce, expiry, v, r, s);
      const summonerDelegate = await sharesToken.delegates(users.summoner.address);
      expect(summonerDelegate).to.equal(users.shaman.address);
    });

    it("require fail - nonce is re-used", async () => {
      const expiry = (await blockTime()) + 10000;
      const nonce = 0;
      const signature = await signDelegation(
        chainId,
        await sharesToken.getAddress(),
        signer,
        await sharesToken.name(),
        users.shaman.address,
        nonce,
        expiry
      );

      const { v, r, s } = ethers.Signature.from(signature);
      await users.shaman.shares?.delegateBySig(users.shaman.address, nonce, expiry, v, r, s);
      expect(
        users.shaman.shares?.delegateBySig(users.shaman.address, nonce, expiry, v, r, s)
      ).to.be.revertedWith(sharesRevertMessages.invalidNonce);
    });

    it("require fail - signature expired", async () => {
      const nonce = 0;
      const signature = await signDelegation(
        chainId,
        await sharesToken.getAddress(),
        signer,
        await sharesToken.name(),
        users.shaman.address,
        nonce,
        0
      );

      const { v, r, s } = ethers.Signature.from(signature);
      expect(
        users.shaman.shares?.delegateBySig(users.shaman.address, nonce, 0, v, r, s)
      ).to.be.revertedWith(sharesRevertMessages.signatureExpired);
    });
  });

  describe("processProposal", function () {

    const quorumGovernanceConfig = abiCoder.encode(
      ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256"],
      [
        deploymentConfig.VOTING_PERIOD_IN_SECONDS,
        deploymentConfig.GRACE_PERIOD_IN_SECONDS,
        deploymentConfig.PROPOSAL_OFFERING,
        10, // QUORUM_PERCENT
        deploymentConfig.SPONSOR_THRESHOLD,
        deploymentConfig.MIN_RETENTION_PERCENT,
      ]
    );

    const minRetetionGovernanceConfig = abiCoder.encode(
      ["uint32", "uint32", "uint256", "uint256", "uint256", "uint256"],
      [
        deploymentConfig.VOTING_PERIOD_IN_SECONDS,
        deploymentConfig.GRACE_PERIOD_IN_SECONDS,
        deploymentConfig.PROPOSAL_OFFERING,
        deploymentConfig.QUORUM_PERCENT,
        deploymentConfig.SPONSOR_THRESHOLD,
        90, // MIN_RETENTION_PERCENT = 90%, ragequit > 10% of shares+loot to trigger
      ]
    );

    it("happy case yes wins", async () => {
      await users.summoner.baal?.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      await users.summoner.baal?.submitVote(1, yes);
      const beforeProcessed = await baal.proposals(1);
      await moveForwardPeriods(defaultDAOSettings.VOTING_PERIOD_IN_SECONDS, 2);
      await baal.processProposal(1, proposal.data);
      const afterProcessed = await baal.proposals(1);
      verifyProposal(afterProcessed, beforeProcessed);
      const state = await baal.state(1);
      expect(state).to.equal(PROPOSAL_STATES.PROCESSED);
      const propStatus = await baal.getProposalStatus(1);
      expect(propStatus).to.eql([false, true, true, false]);
    });

    it("require fail - not enough gas", async () => {
      const baalGas = 10000000;
      await users.summoner.baal?.submitProposal(
        proposal.data,
        proposal.expiration,
        baalGas,
        ethers.id(proposal.details)
      );

      await users.summoner.baal?.submitVote(1, yes);
      await moveForwardPeriods(defaultDAOSettings.VOTING_PERIOD_IN_SECONDS, 3);

      // const procprop = baal.processProposal(1, proposal.data);
      const procprop =  baal.processProposal(1, proposal.data, {gasPrice: ethers.parseUnits('1', 'gwei'), gasLimit: 10000000})

      expect(procprop).to.be.revertedWith(revertMessages.notEnoughGas);

      const state = await baal.state(1);
      expect(state).to.equal(PROPOSAL_STATES.READY);
    });

    it("require fail - baalGas to high", async () => {
      const baalGas = 20000001;
      await expect(users.summoner.baal?.submitProposal(
        proposal.data,
        proposal.expiration,
        baalGas,
        ethers.id(proposal.details)
      )).to.be.revertedWith(revertMessages.baalGasToHigh);

    });

    it("has enough baalGas", async () => {
      const baalGas = 1000000;
      await users.summoner.baal?.submitProposal(
        proposal.data,
        proposal.expiration,
        baalGas,
        ethers.id(proposal.details)
      );

      await users.summoner.baal?.submitVote(1, yes);
      await moveForwardPeriods(defaultDAOSettings.VOTING_PERIOD_IN_SECONDS, 5);
      await baal.processProposal(1, proposal.data, {
        gasPrice: ethers.parseUnits("100", "gwei"),
        gasLimit: 10000000,
      });

      const state = await baal.state(1);
      expect(state).to.equal(PROPOSAL_STATES.PROCESSED);
    });

    it("require fail - no wins, proposal is defeated", async () => {
      await users.summoner.baal?.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      await users.summoner.baal?.submitVote(1, no);
      await moveForwardPeriods(defaultDAOSettings.VOTING_PERIOD_IN_SECONDS, 5);
      const state = await baal.state(1);
      expect(state).to.equal(PROPOSAL_STATES.DEEFEATED);
      await expect(baal.processProposal(1, proposal.data)).to.be.revertedWith(
        revertMessages.processProposalNotReady
      );
    });

    it("require fail - proposal does not exist", async () => {
      await users.summoner.baal?.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      await users.summoner.baal?.submitVote(1, yes);
      const state = await baal.state(2);
      expect(state).to.equal(PROPOSAL_STATES.UNBORN);
    });

    it("require fail - no sponser", async () => {
      await users.summoner.baal?.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      await users.summoner.baal?.submitVote(1, yes);
      const state = await baal.state(2);
      expect(state).to.equal(PROPOSAL_STATES.UNBORN);
      // proposal.sponsor = null;
      await expect(baal.processProposal(2, proposal.data)).to.be.revertedWith(
        revertMessages.proposalNotSponsored
      );
    });

    it("require fail - prev proposal not processed", async () => {
      await users.summoner.baal?.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      await users.summoner.baal?.submitVote(1, yes);
      await users.summoner.baal?.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      await users.summoner.baal?.submitVote(2, yes);
      await moveForwardPeriods(defaultDAOSettings.VOTING_PERIOD_IN_SECONDS, 2);
      await expect(baal.processProposal(2, proposal.data)).to.be.revertedWith(
        "prev!processed" // TODO:
      );
    });

    it("require fail - proposal data mismatch on processing", async () => {
      await users.summoner.baal?.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      const badSelfTransferAction = encodeMultiAction(
        multisend,
        ["0xbeefbabe"],
        [await baal.getAddress()],
        ['0'],
        [0]
      );
      await users.summoner.baal?.submitVote(1, yes);
      await moveForwardPeriods(defaultDAOSettings.VOTING_PERIOD_IN_SECONDS, 2);
      await expect(
        baal.processProposal(1, badSelfTransferAction)
      ).to.be.revertedWith("incorrect calldata"); // TODO:
    });

    it("require fail - proposal not in voting", async () => {
      await users.shaman.baal?.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );

      await expect(users.summoner.baal?.processProposal(1, proposal.data)).to.be.revertedWith(
        revertMessages.proposalNotSponsored
      ); // fail at submitted

      await users.summoner.baal?.sponsorProposal(1);
      await expect(baal.processProposal(1, proposal.data)).to.be.revertedWith(
        revertMessages.processProposalNotReady
      ); // fail at voting

      await users.summoner.baal?.submitVote(1, yes);
      const beforeProcessed = await baal.proposals(1);
      await moveForwardPeriods(defaultDAOSettings.VOTING_PERIOD_IN_SECONDS, 1);
      const state1 = await baal.state(1);
      expect(state1).to.equal(PROPOSAL_STATES.GRACE);
      await expect(baal.processProposal(1, proposal.data)).to.be.revertedWith(
        revertMessages.processProposalNotReady
      ); // fail at grace

      await moveForwardPeriods(defaultDAOSettings.VOTING_PERIOD_IN_SECONDS, 1);
      await baal.processProposal(1, proposal.data); // propsal ready, works
      const afterProcessed = await baal.proposals(1);
      verifyProposal(afterProcessed, beforeProcessed);
      const state = await baal.state(1);
      expect(state).to.equal(PROPOSAL_STATES.PROCESSED);

      const propStatus = await baal.getProposalStatus(1);
      expect(propStatus).to.eql([false, true, true, false]);
    });

    it("require fail - proposal cancelled", async () => {
      await users.summoner.baal?.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      await users.summoner.baal?.submitVote(1, yes);
      await users.shaman.baal?.cancelProposal(1);
      await moveForwardPeriods(defaultDAOSettings.VOTING_PERIOD_IN_SECONDS, 2);
      const state = await baal.state(1);
      expect(state).to.equal(PROPOSAL_STATES.CANCELLED);
      await expect(baal.processProposal(1, proposal.data)).to.be.revertedWith(
        revertMessages.processProposalNotReady
      );
    });

    it("require fail - proposal expired 2", async () => {
      const now = await blockTime();
      const expiration =
        now +
        deploymentConfig.VOTING_PERIOD_IN_SECONDS +
        deploymentConfig.GRACE_PERIOD_IN_SECONDS +
        60;

      await users.summoner.baal?.submitProposal(
        proposal.data,
        expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      await users.summoner.baal?.submitVote(1, yes);
      await moveForwardPeriods(defaultDAOSettings.VOTING_PERIOD_IN_SECONDS, 2);
      const state1 = await baal.state(1);
      expect(state1).to.equal(PROPOSAL_STATES.READY);

      const beforeProcessed = await baal.proposals(1);
      await baal.processProposal(1, proposal.data);
      const afterProcessed = await baal.proposals(1);
      verifyProposal(afterProcessed, beforeProcessed);
      const state2 = await baal.state(1);
      expect(state2).to.equal(PROPOSAL_STATES.PROCESSED);

      const propStatus = await baal.getProposalStatus(1);
      expect(propStatus).to.eql([false, true, false, false]); // passed [3] is false
    });

    it("edge case - exactly at quorum", async () => {
      // mint shares to make total shares supply 2000 so summoner has exectly 10% w/ 200 shares
      const amountToMint = BigInt(2000) - await baal.totalShares();
      console.log(await baal.totalShares(), typeof await baal.totalShares())
      await users.shaman.baal?.mintShares([users.shaman.address], [amountToMint]);
      // const totalSupply = await baal.totalSupply();
      const totalSupply = await baal.totalShares();
      expect(totalSupply).to.equal(2000);
      await users.summoner.baal?.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      await users.summoner.baal?.submitVote(1, yes);
      await moveForwardPeriods(defaultDAOSettings.VOTING_PERIOD_IN_SECONDS, 2);
      const state1 = await baal.state(1);
      expect(state1).to.equal(PROPOSAL_STATES.READY);
      await users.shaman.baal?.setGovernanceConfig(quorumGovernanceConfig); // set quorum to 10%
      const beforeProcessed = await baal.proposals(1);
      await baal.processProposal(1, proposal.data);
      const afterProcessed = await baal.proposals(1);
      
      verifyProposal(afterProcessed, beforeProcessed);
      const state2 = await baal.state(1);
      expect(state2).to.equal(PROPOSAL_STATES.PROCESSED);
      const propStatus = await baal.getProposalStatus(1);
      expect(propStatus).to.eql([false, true, true, false]); // passed [3] is true
    });

    it("quorum should not factor loot", async () => {
       // mint shares so summoner has > 10% w/ 200 shares
      const amountToMint = BigInt(1000) - (await baal.totalShares());
      await users.shaman.baal?.mintShares([users.shaman.address], [amountToMint]);
      await users.shaman.baal?.mintLoot([users.shaman.address], [100000000000]); // mint 100000000000 loot so summoner has a ton of it

      await users.summoner.baal?.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      await users.summoner.baal?.submitVote(1, yes);
      await moveForwardPeriods(defaultDAOSettings.VOTING_PERIOD_IN_SECONDS, 2);
      const state1 = await baal.state(1);
      expect(state1).to.equal(PROPOSAL_STATES.READY);
      await users.shaman.baal?.setGovernanceConfig(quorumGovernanceConfig); // set quorum to 10%
      const beforeProcessed = await baal.proposals(1);
      await baal.processProposal(1, proposal.data);
      const afterProcessed = await baal.proposals(1);
      verifyProposal(afterProcessed, beforeProcessed);
      const state2 = await baal.state(1);
      expect(state2).to.equal(PROPOSAL_STATES.PROCESSED);
      const propStatus = await baal.getProposalStatus(1);
      expect(propStatus).to.eql([false, true, true, false]); // passed [3] is true
    });

    it("edge case - just under quorum", async () => {
      // mint shares so summoner has <10% w/ 200 shares
      const amountToMint = BigInt(2001) - (await baal.totalShares());
      await users.shaman.baal?.mintShares([users.shaman.address], [amountToMint]);

      await users.summoner.baal?.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      await users.summoner.baal?.submitVote(1, yes);
      await moveForwardPeriods(defaultDAOSettings.VOTING_PERIOD_IN_SECONDS, 2);
      const state1 = await baal.state(1);
      expect(state1).to.equal(PROPOSAL_STATES.READY);
      await users.shaman.baal?.setGovernanceConfig(quorumGovernanceConfig); // set quorum to 10%
      const beforeProcessed = await baal.proposals(1);
      await baal.processProposal(1, proposal.data);
      const afterProcessed = await baal.proposals(1);
      verifyProposal(afterProcessed, beforeProcessed);
      const state2 = await baal.state(1);
      expect(state2).to.equal(PROPOSAL_STATES.PROCESSED);
      const propStatus = await baal.getProposalStatus(1);
      expect(propStatus).to.eql([false, true, false, false]); // passed [3] is false
    });

    it("edge case - exactly at minRetentionPercent", async () => {
      await users.shaman.baal?.setGovernanceConfig(minRetetionGovernanceConfig); // set min retention to 90%

      await users.summoner.baal?.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      await users.summoner.baal?.submitVote(1, yes);
      await moveForwardPeriods(defaultDAOSettings.VOTING_PERIOD_IN_SECONDS, 2);
      const state1 = await baal.state(1);
      // ragequit 30 shares out of 200 shares and 100 loot out of 500 -> 10% totalSupply
      await users.summoner.baal?.ragequit(users.summoner.address, 30, 100, [await weth.getAddress()]);
      expect(state1).to.equal(PROPOSAL_STATES.READY);
      const beforeProcessed = await baal.proposals(1);
      await baal.processProposal(1, proposal.data);
      const afterProcessed = await baal.proposals(1);
      verifyProposal(afterProcessed, beforeProcessed);
      const state2 = await baal.state(1);
      expect(state2).to.equal(PROPOSAL_STATES.PROCESSED);
      const propStatus = await baal.getProposalStatus(1);
      expect(propStatus).to.eql([false, true, true, false]); // passed [3] is true
    });

    it("edge case - just below minRetentionPercent - shares+loot", async () => {
      await users.shaman.baal?.setGovernanceConfig(minRetetionGovernanceConfig); // set min retention to 90%

      await users.summoner.baal?.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      await users.summoner.baal?.submitVote(1, yes);
      await moveForwardPeriods(defaultDAOSettings.VOTING_PERIOD_IN_SECONDS, 2);
      const state1 = await baal.state(1);
      // ragequit 31 shares out of 200, and 101 loot out of 500 -> > 10% totalSupply
      await users.summoner.baal?.ragequit(users.summoner.address, 31, 101, [await weth.getAddress()]);
      expect(state1).to.equal(PROPOSAL_STATES.READY);
      const beforeProcessed = await baal.proposals(1);
      await baal.processProposal(1, proposal.data);
      const afterProcessed = await baal.proposals(1);
      verifyProposal(afterProcessed, beforeProcessed);
      const state2 = await baal.state(1);
      expect(state2).to.equal(PROPOSAL_STATES.PROCESSED);
      const propStatus = await baal.getProposalStatus(1);
      expect(propStatus).to.eql([false, true, false, false]); // passed [3] is false - min retention exceeded
    });

    it("edge case - just below minRetentionPercent - just shares", async () => {
      await users.shaman.baal?.setGovernanceConfig(minRetetionGovernanceConfig); // set min retention to 90%

      await users.summoner.baal?.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      await users.summoner.baal?.submitVote(1, yes);
      await moveForwardPeriods(defaultDAOSettings.VOTING_PERIOD_IN_SECONDS, 2);
      const state1 = await baal.state(1);
      // ragequit 131 shares out of 200, and 0 out of 500 -> > 10% totalSupply
      await users.summoner.baal?.ragequit(users.summoner.address, 131, 0, [await weth.getAddress()]);
      expect(state1).to.equal(PROPOSAL_STATES.READY);
      const beforeProcessed = await baal.proposals(1);
      await baal.processProposal(1, proposal.data);
      const afterProcessed = await baal.proposals(1);
      verifyProposal(afterProcessed, beforeProcessed);
      const state2 = await baal.state(1);
      expect(state2).to.equal(PROPOSAL_STATES.PROCESSED);
      const propStatus = await baal.getProposalStatus(1);
      expect(propStatus).to.eql([false, true, false, false]); // passed [3] is false - min retention exceeded
    });

    it("edge case - just below minRetentionPercent - just loot", async () => {
      await users.shaman.baal?.setGovernanceConfig(minRetetionGovernanceConfig); // set min retention to 90%

      await users.summoner.baal?.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      await users.summoner.baal?.submitVote(1, yes);
      await moveForwardPeriods(defaultDAOSettings.VOTING_PERIOD_IN_SECONDS, 2);
      const state1 = await baal.state(1);
      // ragequit 0 shares out of 200, and 131 loot out of 500 -> > 10% totalSupply
      await users.summoner.baal?.ragequit(users.summoner.address, 0, 131, [await weth.getAddress()]);
      expect(state1).to.equal(PROPOSAL_STATES.READY);
      const beforeProcessed = await baal.proposals(1);
      await baal.processProposal(1, proposal.data);
      const afterProcessed = await baal.proposals(1);
      verifyProposal(afterProcessed, beforeProcessed);
      const state2 = await baal.state(1);
      expect(state2).to.equal(PROPOSAL_STATES.PROCESSED);
      const propStatus = await baal.getProposalStatus(1);
      expect(propStatus).to.eql([false, true, false, false]); // passed [3] is false - min retention exceeded
    });

    it("scenario - offer tribute unsafe", async () => {
      await users.summoner.weth?.transfer(users.s1.address, 100); // summoner transfer 100 weth
      const offerWeth = weth.interface.encodeFunctionData("transferFrom", [
        users.s1.address,
        await gnosisSafe.getAddress(),
        100,
      ]);
      const tributeMultiAction = encodeMultiAction(
        multisend,
        [offerWeth],
        [await weth.getAddress()],
        ['0'],
        [0]
      );

      proposal.data = tributeMultiAction;
      proposal.details = 'Tribute Proposal';

      await users.s1.weth?.approve(await gnosisSafe.getAddress(), 100);

      await users.summoner.baal?.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      await users.summoner.baal?.submitVote(1, yes);
      const beforeProcessed = await baal.proposals(1);
      await moveForwardPeriods(defaultDAOSettings.VOTING_PERIOD_IN_SECONDS, 2);
      await baal.processProposal(1, proposal.data);
      const afterProcessed = await baal.proposals(1);
      verifyProposal(afterProcessed, beforeProcessed, {
        processed: true,
        passed: true,
      });
      const applicantWethBalance = await weth.balanceOf(users.s1.address);
      expect(applicantWethBalance).to.equal(0);
      const safeWethBalance = await weth.balanceOf(await gnosisSafe.getAddress());
      expect(safeWethBalance).to.equal(100);
    });

    it("scenario - two propsals, prev is processed", async () => {
      await users.summoner.baal?.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      await users.summoner.baal?.submitVote(1, yes);
      await users.summoner.baal?.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      await users.summoner.baal?.submitVote(2, yes);
      const beforeProcessed = await baal.proposals(2);
      await moveForwardPeriods(defaultDAOSettings.VOTING_PERIOD_IN_SECONDS, 2);
      await baal.processProposal(1, proposal.data);
      const state1 = await baal.state(1);
      expect(state1).to.equal(PROPOSAL_STATES.PROCESSED); // prev prop processed
      await baal.processProposal(2, proposal.data);
      const afterProcessed = await baal.proposals(2);
      verifyProposal(afterProcessed, beforeProcessed);
      const state2 = await baal.state(2);
      expect(state2).to.equal(PROPOSAL_STATES.PROCESSED);
      const propStatus = await baal.getProposalStatus(2);
      expect(propStatus).to.eql([false, true, true, false]);
    });

    it("scenario - two propsals, prev is defeated", async () => {
      await users.summoner.baal?.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      await users.summoner.baal?.submitVote(1, no);
      await users.summoner.baal?.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      await users.summoner.baal?.submitVote(2, yes);
      const beforeProcessed = await baal.proposals(2);
      await moveForwardPeriods(defaultDAOSettings.VOTING_PERIOD_IN_SECONDS, 2);
      const state1 = await baal.state(1);
      expect(state1).to.equal(PROPOSAL_STATES.DEEFEATED); // prev prop defeated
      await baal.processProposal(2, proposal.data);
      const afterProcessed = await baal.proposals(2);
      verifyProposal(afterProcessed, beforeProcessed);
      const state2 = await baal.state(2);
      expect(state2).to.equal(PROPOSAL_STATES.PROCESSED);
      const propStatus = await baal.getProposalStatus(2);
      expect(propStatus).to.eql([false, true, true, false]);
    });

    it("scenario - two propsals, prev is cancelled", async () => {
      await users.summoner.baal?.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      await users.summoner.baal?.submitVote(1, yes);
      await users.shaman.baal?.cancelProposal(1);
      await users.summoner.baal?.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      await users.summoner.baal?.submitVote(2, yes);
      const beforeProcessed = await baal.proposals(2);
      await moveForwardPeriods(defaultDAOSettings.VOTING_PERIOD_IN_SECONDS, 2);
      const state1 = await baal.state(1);
      expect(state1).to.equal(PROPOSAL_STATES.CANCELLED); // prev prop cancelled
      await baal.processProposal(2, proposal.data);
      const afterProcessed = await baal.proposals(2);
      verifyProposal(afterProcessed, beforeProcessed);
      const state2 = await baal.state(2);
      expect(state2).to.equal(PROPOSAL_STATES.PROCESSED);
      const propStatus = await baal.getProposalStatus(2);
      expect(propStatus).to.eql([false, true, true, false]);
    });

    it("happy case - mint shares via proposal", async () => {
      const minting = 100;

      expect(
        await sharesToken.balanceOf(users.applicant.address)
      ).to.equal(defaultSummonSetup.shares);

      const mintAction = baal.interface.encodeFunctionData(
        "mintShares",
        [[users.applicant.address], [minting]]
      );

      const encodedAction = encodeMultiAction(
        multisend,
        [mintAction],
        [await baal.getAddress()],
        ['0'],
        [0]
      );

      await expect(proposalHelpers.submitAndProcessProposal({
          baal,
          encodedAction,
          proposal,
          proposalId: 1,
        })
      ).to.emit(baal, "ProcessProposal").withArgs(1, true, false);

      expect(
        await sharesToken.balanceOf(users.applicant.address)
      ).to.equal(defaultSummonSetup.shares + minting);
    });

    it("happy case - burn shares via proposal", async () => {
      const burning = 100;

      expect(
        await sharesToken.balanceOf(users.summoner.address)
      ).to.equal(users.summoner.sharesInitial);

      const burnAction = baal.interface.encodeFunctionData(
        "burnShares",
        [[users.summoner.address], [burning]]
      );

      const encodedAction = encodeMultiAction(
        multisend,
        [burnAction],
        [await baal.getAddress()],
        ['0'],
        [0]
      );

      await expect(proposalHelpers.submitAndProcessProposal({
          baal,
          encodedAction,
          proposal,
          proposalId: 1
        })
      ).to.emit(baal, "ProcessProposal").withArgs(1, true, false);

      expect(
        await sharesToken.balanceOf(users.summoner.address)
      ).to.equal(users.summoner.sharesInitial - burning);
    });

    it("happy case - mint loot via proposal", async () => {
      const minting = 100;

      expect(
        await lootToken.balanceOf(users.applicant.address)
      ).to.equal(defaultSummonSetup.loot);

      const mintAction = await baal.interface.encodeFunctionData(
        "mintLoot",
        [[users.applicant.address], [minting]]
      );

      const encodedAction = encodeMultiAction(
        multisend,
        [mintAction],
        [await baal.getAddress()],
        ['0'],
        [0]
      );

      await expect(proposalHelpers.submitAndProcessProposal({
          baal,
          encodedAction,
          proposal,
          proposalId: 1
        })
      ).to.emit(baal, "ProcessProposal").withArgs(1, true, false);

      expect(
        await lootToken.balanceOf(users.applicant.address)
      ).to.equal(defaultSummonSetup.loot + minting);
    });

    it("happy case - burn loot via proposal", async () => {
      const burning = 100;

      expect(
        await lootToken.balanceOf(users.summoner.address)
      ).to.equal(defaultSummonSetup.loot);

      const burnAction = baal.interface.encodeFunctionData(
        "burnLoot",
        [[users.summoner.address], [burning]]
      );

      const encodedAction = encodeMultiAction(
        multisend,
        [burnAction],
        [await baal.getAddress()],
        ['0'],
        [0]
      );

      await expect(proposalHelpers.submitAndProcessProposal({
          baal,
          encodedAction,
          proposal,
          proposalId: 1
        })
      ).to.emit(baal, "ProcessProposal").withArgs(1, true, false);

      expect(
        await lootToken.balanceOf(users.summoner.address)
      ).to.equal(defaultSummonSetup.loot - burning);
    });

    // setting and unsetting shamans covered

    // TODO set / unset tokens via proposal
  });

  // ----------------------------------------------------------
  // ------------------ RAGEQUIT ------------------------------
  // ----------------------------------------------------------

  describe("ragequit", function () {
    const depositAmount = BigInt(100);

    it("happy case - full ragequit", async () => {
      const summonerWethBefore = await weth.balanceOf(users.summoner.address);

      await weth.transfer(await gnosisSafe.getAddress(), depositAmount);
      const share = (
        BigInt(users.summoner.sharesInitial)
        +  BigInt(defaultSummonSetup.loot)
      ) * depositAmount / (await baal.totalSupply());

      await users.summoner.baal?.ragequit(
        users.summoner.address,
        users.summoner.sharesInitial,
        defaultSummonSetup.loot,
        [await weth.getAddress()]
      );
      const sharesAfter = await sharesToken.balanceOf(users.summoner.address);
      const lootAfter = await lootToken.balanceOf(users.summoner.address);
      const summonerWethAfter = await weth.balanceOf(users.summoner.address);
      const safeWethAfter = await weth.balanceOf(await gnosisSafe.getAddress());
      expect(lootAfter).to.equal(0);
      expect(sharesAfter).to.equal(0);
      expect(summonerWethAfter).to.equal(BigInt(summonerWethBefore) + share);
      expect(safeWethAfter).to.equal(depositAmount - share);
    });

    it("happy case - partial ragequit", async () => {
      const lootBefore = await lootToken.balanceOf(users.summoner.address);
      const sharesBefore = await sharesToken.balanceOf(users.summoner.address);
      const lootToBurn = BigInt(defaultSummonSetup.loot) / BigInt(2);
      // const sharesToBurn = (await baal.totalShares()).div(2); // half of shares supplied
      const sharesToBurn = BigInt(defaultSummonSetup.shares) / BigInt(2);
      const summonerWethBefore = await weth.balanceOf(users.summoner.address);
      const safeWethBefore = await weth.balanceOf(await gnosisSafe.getAddress());
      
      await weth.transfer(await gnosisSafe.getAddress(), depositAmount);
      const share = (sharesToBurn + lootToBurn) * depositAmount / (await baal.totalSupply());

      await users.summoner.baal?.ragequit(
        users.summoner.address,
        sharesToBurn,
        lootToBurn,
        [await weth.getAddress()]
      );
      const sharesAfter = await sharesToken.balanceOf(users.summoner.address);
      const lootAfter = await lootToken.balanceOf(users.summoner.address);
      const summonerWethAfter = await weth.balanceOf(users.summoner.address);
      const safeWethAfter = await weth.balanceOf(await gnosisSafe.getAddress());
      
      expect(lootAfter).to.equal(BigInt(lootBefore) - lootToBurn);
      expect(sharesAfter).to.equal(BigInt(sharesBefore) - sharesToBurn);
      expect(summonerWethAfter).to.equal(BigInt(summonerWethBefore) + share);
      expect(safeWethAfter).to.equal(depositAmount - share);
    });

    it("happy case - full ragequit to different address", async () => {
      const applicantWethBefore = await weth.balanceOf(users.applicant.address);
      const summonerWethBefore = await weth.balanceOf(users.summoner.address);
      
      await weth.transfer(await gnosisSafe.getAddress(), depositAmount);
      const share = (
        BigInt(users.summoner.sharesInitial)
        +  BigInt(defaultSummonSetup.loot)
      ) * depositAmount / (await baal.totalSupply());

      await users.summoner.baal?.ragequit(
        users.applicant.address, // ragequit to applicant
        users.summoner.sharesInitial,
        defaultSummonSetup.loot,
        [await weth.getAddress()]
      );
      const sharesAfter = await sharesToken.balanceOf(users.summoner.address);
      const lootAfter = await lootToken.balanceOf(users.summoner.address);
      const summonerWethAfter = await weth.balanceOf(users.summoner.address);
      const safeWethAfter = await weth.balanceOf(await gnosisSafe.getAddress());
      const applicantWethAfter = await weth.balanceOf(users.applicant.address);
      expect(lootAfter).to.equal(0);
      expect(sharesAfter).to.equal(0);
      expect(summonerWethAfter).to.equal(summonerWethBefore);
      expect(safeWethAfter).to.equal(depositAmount - share);
      expect(applicantWethAfter).to.equal(applicantWethBefore + share);
    });

    it("happy case - full ragequit - two tokens", async () => {
      // expect: receive 50% of weth and dai from DAO

      const summonerWethBefore = await weth.balanceOf(users.summoner.address);
      const summonerDaiBefore = await dai.balanceOf(users.summoner.address);

      await weth.transfer(await gnosisSafe.getAddress(), depositAmount);
      await dai.transfer(await gnosisSafe.getAddress(), depositAmount * BigInt(2));

      const lootToBurn = defaultSummonSetup.loot;
      const lootBefore = await lootToken.balanceOf(users.summoner.address);

      const shareWeth = (
        BigInt(users.summoner.sharesInitial)
        + BigInt(lootToBurn)
      ) * depositAmount / (await baal.totalSupply());
      const shareDai = (
        BigInt(users.summoner.sharesInitial)
        + BigInt(lootToBurn)
      ) * depositAmount * BigInt(2) / (await baal.totalSupply());

      const orderedTokens = [await dai.getAddress(), await weth.getAddress()].sort((a, b) => {
        return parseInt(a.slice(2), 16) - parseInt(b.slice(2), 16);
      });

      await users.summoner.baal?.ragequit(
        users.summoner.address,
        users.summoner.sharesInitial,
        lootToBurn,
        orderedTokens
      );

      const sharesAfter = await sharesToken.balanceOf(users.summoner.address);
      const lootAfter = await lootToken.balanceOf(users.summoner.address);
      const summonerWethAfter = await weth.balanceOf(users.summoner.address);
      const summonerDaiAfter = await dai.balanceOf(users.summoner.address);
      const safeWethAfter = await weth.balanceOf(await gnosisSafe.getAddress());
      const safeDaiAfter = await dai.balanceOf(await gnosisSafe.getAddress());

      expect(sharesAfter).to.equal(0);
      expect(lootAfter).to.equal(lootBefore - BigInt(lootToBurn));
      expect(summonerWethAfter).to.equal(summonerWethBefore + shareWeth); // minus 100, plus 50
      expect(summonerDaiAfter).to.equal(summonerDaiBefore + shareDai); // minus 200, plus 100
      expect(safeWethAfter).to.equal(depositAmount - shareWeth);
      expect(safeDaiAfter).to.equal((depositAmount * BigInt(2)) - shareDai);
    });
  });

  describe("ragequit", function () {
    const depositAmount = BigInt(100);

    // TODO:
    // it("collects tokens not on the list", async () => {
    //   // note - skips having shaman add LOOT to guildTokens
    //   // transfer 300 loot to DAO (summoner has 200 shares + 500 loot, so that's 50% of total)
    //   // transfer 100 weth to DAO
    //   // ragequit 100% of remaining shares & loot
    //   // expect: receive 50% of weth / loot from DAO
    //   await users.shaman.baal?.mintShares([users.applicant.address], [100]); // 100 extra to even loot supply
    //   const summonerWethBefore = await weth.balanceOf(users.summoner.address);

    //   await weth.transfer(await gnosisSafe.getAddress(), depositAmount);
    //   await users.summoner.loot?.transfer(await gnosisSafe.getAddress(), 300);

    //   const tokens = [lootToken.address, await weth.getAddress()].sort((a, b) => {
    //     return parseInt(a.slice(2), 16) - parseInt(b.slice(2), 16);
    //   });
    //   console.log('Supply', (await baal.totalSupply()).toString());

    //   await users.summoner.baal?.ragequit(
    //     users.summoner.address,
    //     users.summoner.sharesInitial,
    //     defaultSummonSetup.loot - 300,
    //     tokens
    //   );

    //   const sharesAfter = await sharesToken.balanceOf(users.summoner.address);
    //   const lootAfter = await lootToken.balanceOf(users.summoner.address);
    //   const safeLootAfter = await lootToken.balanceOf(await gnosisSafe.getAddress());
    //   const summonerWethAfter = await weth.balanceOf(users.summoner.address);
    //   const safeWethAfter = await weth.balanceOf(await gnosisSafe.getAddress());
    //   // TODO: Should be 85?
    //   // expect(lootAfter).to.equal(150); // burn 200, receive 150
    //   expect(sharesAfter).to.equal(0);
    //   expect(summonerWethAfter).to.equal(summonerWethBefore + BigInt(50)); // minus 100, plus 50
    //   expect(safeWethAfter).to.equal(50);
    //   expect(safeLootAfter).to.equal(150);
    // });

    it("require fail - enforces ascending order", async () => {
      await weth.transfer(await gnosisSafe.getAddress(), depositAmount);
      await users.summoner.loot?.transfer(await baal.getAddress(), 300);
      const tokens = [await lootToken.getAddress(), await weth.getAddress()]
        .sort((a, b) => {
          return parseInt(a.slice(2), 16) - parseInt(b.slice(2), 16);
        })
        .reverse();

      await expect(
        users.summoner.baal?.ragequit(
          users.summoner.address,
          users.summoner.sharesInitial,
          defaultSummonSetup.loot - 300,
          tokens
        )
      ).to.be.revertedWith(revertMessages.ragequitUnordered);
    });

    it("require fail - prevents actual duplicate", async () => {
      await weth.transfer(await gnosisSafe.getAddress(), depositAmount);
      await expect(
        users.summoner.baal?.ragequit(
          users.summoner.address,
          defaultSummonSetup.shares,
          defaultSummonSetup.loot - 300,
          [
            await weth.getAddress(),
            await weth.getAddress(),
          ]
        )
      ).to.be.revertedWith(revertMessages.ragequitUnordered);
    });
  });

  // --------------------------------------------------------
  // ------------------ VOTING ------------------------------
  // --------------------------------------------------------

  describe("getVotes", function () {
    it("happy case - account with votes", async () => {
      const currentVotes = await sharesToken.getVotes(users.summoner.address);
      const nCheckpoints = await sharesToken.numCheckpoints(users.summoner.address);
      const checkpoints = await sharesToken.checkpoints(
        users.summoner.address,
        nCheckpoints - BigInt(1)
      );
      const votes = checkpoints.votes;
      expect(currentVotes).to.equal(votes);
    });

    it("happy case - account without votes", async () => {
      const currentVotes = await sharesToken.getVotes(users.shaman.address);
      expect(currentVotes).to.equal(0);
    });
  });

  describe("getPastVotes", function () {
    beforeEach(async function () {
      await users.summoner.baal?.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
    });

    it("happy case - yes vote", async () => {
      const blockT = await blockTime();
      await users.summoner.baal?.submitVote(1, yes);
      const priorVote = await sharesToken.getPastVotes(users.summoner.address, blockT);
      const nCheckpoints = await sharesToken.numCheckpoints(users.summoner.address);
      const votes = (
        await sharesToken.checkpoints(users.summoner.address, nCheckpoints - BigInt(1))
      ).votes;
      expect(priorVote).to.equal(votes);
    });

    it("happy case - no vote", async () => {
      const blockT = await blockTime();
      await users.summoner.baal?.submitVote(1, no);
      const priorVote = await sharesToken.getPastVotes(users.summoner.address, blockT);
      const nCheckpoints = await sharesToken.numCheckpoints(users.summoner.address);
      const votes = (
        await sharesToken.checkpoints(users.summoner.address, nCheckpoints - BigInt(1))
      ).votes;
      expect(priorVote).to.equal(votes);
    });

    it("require fail - timestamp not determined", async () => {
      const blockT = await blockTime();
      await expect(
        sharesToken.getPastVotes(users.summoner.address, blockT)
      ).to.be.revertedWith("!determined");
    });
  });
});

describe("Baal contract - offering required", function () {
  let customConfig = {
    ...deploymentConfig,
    PROPOSAL_OFFERING: 69,
    SPONSOR_THRESHOLD: 1,
  };

  let baal: Baal;
  let multisend: MultiSend;
  let gnosisSafe: GnosisSafe;

  let proposal: ProposalType;

  let users: {
    [key: string]: Signer;
  };

  beforeEach(async function () {

    const {
      Baal,
      GnosisSafe,
      MultiSend,
      signers
    } = await baalSetup({
      daoSettings: customConfig,
    });

    baal = Baal;
    gnosisSafe = GnosisSafe;
    multisend = MultiSend;
    users = signers;

    const selfTransferAction = encodeMultiAction(
      multisend,
      ["0x"],
      [await gnosisSafe.getAddress()],
      ['0'],
      [0]
    );

    proposal = {
      flag: 0,
      data: selfTransferAction,
      details: "all hail baal",
      expiration: 0,
      baalGas: 0,
    };
  });

  describe("submitProposal", function () {
    it("submit proposal", async () => {
      // note - this also tests that the proposal is NOT sponsored
      const countBefore = await baal.proposalCount();

      await users.shaman.baal?.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details),
        { value: 69 }
      );

      const countAfter = await baal.proposalCount();
      expect(countAfter).to.equal(BigInt(countBefore) + BigInt(1));

      const proposalData = await baal.proposals(1);
      expect(proposalData.id).to.equal(BigInt(1));
    });

    it("happy case - sponsors can submit without offering, auto-sponsors", async () => {
      const countBefore = await baal.proposalCount();

      await users.summoner.baal?.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      const now = await blockTime();

      const countAfter = await baal.proposalCount();
      expect(countAfter).to.equal(BigInt(countBefore) + BigInt(1));
      const proposalData = await baal.proposals(1);
      expect(proposalData.id).to.equal(BigInt(1));
      expect(proposalData.votingStarts).to.equal(BigInt(now));
    });

    it("edge case - sponsors can submit without offering at threshold", async () => {
      const countBefore = await baal.proposalCount();
      await users.summoner.shares?.transfer(users.shaman.address, 1); // transfer 1 share to shaman, putting them at threshold (1)

      await users.shaman.baal?.submitProposal(
        proposal.data,
        proposal.expiration,
        proposal.baalGas,
        ethers.id(proposal.details)
      );
      const now = await blockTime();

      const countAfter = await baal.proposalCount();
      expect(countAfter).to.equal(BigInt(countBefore) + BigInt(1));
      const proposalData = await baal.proposals(1);
      expect(proposalData.id).to.equal(BigInt(1));
      expect(proposalData.votingStarts).to.equal(now);
    });

    it("require fail - no offering offered", async () => {
      await expect(
        users.shaman.baal?.submitProposal(
          proposal.data,
          proposal.expiration,
          proposal.baalGas,
          ethers.id(proposal.details)
        )
      ).to.be.revertedWith(revertMessages.submitProposalOffering);
    });
  });
});

describe("Baal contract - summon baal with current safe", function () {
  let avatar: TestAvatar;
  let baalSingleton: Baal;
  let baalSummoner: BaalSummoner;
  let expectedAddress: string;
  let moduleProxyFactory: ModuleProxyFactory;
  let poster: Poster;

  beforeEach(async function () {
    const { deployer } = await getNamedAccounts();

    await deployments.fixture(['Infra', 'BaalSummoner']); // Deployment Tags

    baalSingleton = (await ethers.getContractAt('Baal', (await deployments.get('Baal')).address)) as Baal;
    baalSummoner = (await ethers.getContractAt('BaalSummoner', (await deployments.get('BaalSummoner')).address)) as BaalSummoner;
    moduleProxyFactory = (await ethers.getContractAt('ModuleProxyFactory', (await deployments.get('ModuleProxyFactory')).address)) as ModuleProxyFactory;
    poster = (await ethers.getContractAt('Poster', (await deployments.get('Poster')).address)) as Poster

    const deployedAvatar = await deployments.deploy('TestAvatar', {
      from: deployer,
      args: []
    });
    
    // @ts-expect-error
    avatar = await ethers.getContractAt('TestAvatar', deployedAvatar.address, await ethers.getSigner(deployer)) as TestAvatar;
  });


  describe("Baal summoned after safe", function () {
    it("should have the expected address of the module the same as the deployed", async () => {
      const [summoner, applicant, shaman] = await getUnnamedAccounts();

      const initData = baalSingleton.interface.encodeFunctionData("avatar");
      const saltNonce = '101';

      const masterAddress = await baalSingleton.getAddress()

      expectedAddress = calculateProxyAddress(
        // @ts-expect-error
        { address: await moduleProxyFactory.getAddress() },
        masterAddress,
        initData,
        saltNonce
      );

      await avatar.enableModule(expectedAddress);

      const loot = defaultSummonSetup.loot;
      const lootPaused = defaultSummonSetup.lootPaused;
      const shares = defaultSummonSetup.shares;
      const sharesPaused = defaultSummonSetup.sharesPaused;

      const shamanPermissions = defaultSummonSetup.shamanPermissions;

      const addresses = await setupBaal({
          // @ts-expect-error
          baalSummoner,
          baalSingleton,
          poster,
          config: defaultDAOSettings,
          adminConfig: [sharesPaused, lootPaused],
          shamans: [[shaman], [shamanPermissions]],
          shares: [
              [summoner, applicant],
              [shares, shares]
          ],
          loots: [
              [summoner, applicant],
              [loot, loot]
          ],
          safeAddress: await avatar.getAddress() as `0x${string}`,
          // @ts-expect-error
          forwarderAddress: ethers.ZeroAddress,
          // @ts-expect-error
          lootAddress: ethers.ZeroAddress,
          sharesAddress: ethers.ZeroAddress as `0x${string}`,
          saltNonceOverride: saltNonce
      });

      expect(expectedAddress).to.equal(addresses.baal);
    });
  });
});
