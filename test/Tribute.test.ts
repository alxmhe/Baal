import { expect } from 'chai';
import { ethers } from 'hardhat';

import {
  DAOSettings,
  defaultDAOSettings,
  defaultProposalSettings,
  revertMessages,
} from './utils/baal';
import { moveForwardPeriods } from './utils/evm';
import { baalSetup, ProposalHelpers, Signer } from './utils/fixtures';
import {
  Baal,
  TestERC20,
  TributeMinion,
  Loot,
  MultiSend,
  BaalSummoner,
  GnosisSafe,
  Shares,
} from '../src/types';
import { encodeMultiAction } from '../src/util';

describe("Tribute proposal type", function () {
  let baal: Baal;
  let lootToken: Loot;
  let sharesToken: Shares;
  let weth: TestERC20;
  let multisend: MultiSend;

  let baalSummoner: BaalSummoner;
  let gnosisSafe: GnosisSafe;

  let tributeMinion: TributeMinion;

  let users: {
    [key: string]: Signer;
  };

  const yes = true;
  const no = false;

  let proposalHelpers: ProposalHelpers;

  beforeEach(async () => {
    const {
      Baal,
      Loot,
      Shares,
      BaalSummoner,
      GnosisSafe,
      MultiSend,
      TributeMinion,
      WETH,
      signers,
      helpers,
    } = await baalSetup({});

    baal = Baal;
    lootToken = Loot;
    sharesToken = Shares;
    baalSummoner = BaalSummoner;
    gnosisSafe = GnosisSafe;
    multisend = MultiSend;
    weth = WETH;
    // poster = Poster;
    tributeMinion = TributeMinion;
    users = signers;

    proposalHelpers = helpers;
  });

  describe("Dangerous proposal tribute", () => {
    const tribute = 100;
    const requestedShares = 100;

    it("Allows applicant to tribute tokens in exchange for shares", async () => {
      expect(await weth.balanceOf(await gnosisSafe.getAddress())).to.equal(0);

      await users.applicant.weth?.approve(await gnosisSafe.getAddress(), tribute);

      const currentShares = await sharesToken.balanceOf(users.applicant.address);

      const mintShares = baal.interface.encodeFunctionData("mintShares", [
        [users.applicant.address],
        [requestedShares],
      ]);
      const sendTribute = weth.interface.encodeFunctionData(
        "transferFrom",
        [users.applicant.address, await gnosisSafe.getAddress(), tribute]
      );

      const encodedProposal = encodeMultiAction(
        multisend,
        [mintShares, sendTribute],
        [await baal.getAddress(), await weth.getAddress()],
        ['0', '0'],
        [0, 0]
      );

      await users.applicant.baal?.submitProposal(
        encodedProposal,
        defaultProposalSettings.EXPIRATION,
        defaultProposalSettings.BAAL_GAS,
        ethers.id(defaultProposalSettings.DETAILS),
        { value: defaultDAOSettings.PROPOSAL_OFFERING }
      );
      await baal.submitVote(1, yes);
      await moveForwardPeriods(defaultDAOSettings.VOTING_PERIOD_IN_SECONDS, 2);
      await baal.processProposal(1, encodedProposal);

      expect(await weth.balanceOf(await gnosisSafe.getAddress())).to.equal(BigInt(tribute));
      expect(await sharesToken.balanceOf(users.applicant.address)).to.equal(
        currentShares + BigInt(requestedShares) // current shares plus new shares
      );
    });

    it("EXPLOIT - Allows another proposal to spend tokens intended for tribute", async () => {
      expect(await weth.balanceOf(await gnosisSafe.getAddress())).to.equal(0);

      await users.applicant.weth?.approve(await gnosisSafe.getAddress(), tribute);

      const currentShares = await sharesToken.balanceOf(users.applicant.address);

      const mintShares = baal.interface.encodeFunctionData("mintShares", [
        [users.applicant.address],
        [requestedShares],
      ]);
      const sendTribute = weth.interface.encodeFunctionData(
        "transferFrom",
        [users.applicant.address, await gnosisSafe.getAddress(), tribute]
      );

      const encodedProposal = encodeMultiAction(
        multisend,
        [mintShares, sendTribute],
        [await baal.getAddress(), await weth.getAddress()],
        ['0', '0'],
        [0, 0]
      );
      const maliciousProposal = encodeMultiAction(
        multisend,
        [sendTribute],
        [await weth.getAddress()],
        ['0'],
        [0]
      );

      await users.applicant.baal?.submitProposal(
        encodedProposal,
        defaultProposalSettings.EXPIRATION,
        defaultProposalSettings.BAAL_GAS,
        ethers.id(defaultProposalSettings.DETAILS),
        { value: defaultDAOSettings.PROPOSAL_OFFERING }
      );
      await users.applicant.baal?.submitProposal(
        maliciousProposal,
        defaultProposalSettings.EXPIRATION,
        defaultProposalSettings.BAAL_GAS,
        ethers.id(defaultProposalSettings.DETAILS),
        { value: defaultDAOSettings.PROPOSAL_OFFERING }
      );
      await baal.submitVote(1, no);
      await baal.submitVote(2, yes);
      await moveForwardPeriods(defaultDAOSettings.VOTING_PERIOD_IN_SECONDS, 2);
      // await baal.processProposal(1, encodedProposal)
      await baal.processProposal(2, maliciousProposal);
      expect(await weth.balanceOf(await gnosisSafe.getAddress())).to.equal(tribute);
      expect(await sharesToken.balanceOf(users.applicant.address)).to.equal(currentShares); // only current shares no new ones
    });
  });

  describe("Baal with NO proposal offering - Safe Tribute Proposal", () => {

    const tribute = BigInt(100);
    const requestedShares = BigInt(1234);
    const requestedLoot = BigInt(1007);

    it("allows external tribute minion to submit share proposal in exchange for tokens", async () => {
      expect(await weth.balanceOf(await gnosisSafe.getAddress())).to.equal(0);
      expect(await weth.balanceOf(users.applicant.address)).to.equal(BigInt(1000));

      await users.applicant.weth?.approve(await tributeMinion.getAddress(), 10000);

      const currentShares = await sharesToken.balanceOf(users.applicant.address);

      users.applicant.tributeMinion && await proposalHelpers.submitAndProcessTributeProposal({
        tributeMinion: users.applicant.tributeMinion,
        baal,
        applicantAddress: users.applicant.address,
        tributeToken: await weth.getAddress(),
        tribute,
        requestedShares,
        requestedLoot,
      });

      expect(await sharesToken.balanceOf(users.applicant.address)).to.equal(
        currentShares + requestedShares
      );
      expect(await weth.balanceOf(await gnosisSafe.getAddress())).to.equal(tribute);
    });
  });

  describe("Baal with proposal offering - Safe Tribute Proposal", function () {
    let daoConfig: Partial<DAOSettings>;
    let baal: Baal;
    let gnosisSafe: GnosisSafe;
    let sharesToken: Shares;
    let tributeMinion: TributeMinion;

    const tribute = BigInt(100);
    const requestedShares = BigInt(1234);
    const requestedLoot = BigInt(1007);

    this.beforeEach(async function () {
      daoConfig = {
        PROPOSAL_OFFERING: 69,
        SPONSOR_THRESHOLD: 101,
      };
      const {
        Baal,
        Shares,
        GnosisSafe,
        TributeMinion,
      } = await baalSetup({
        daoSettings: daoConfig,
      });
      baal = Baal;
      gnosisSafe = GnosisSafe;
      sharesToken = Shares;
      tributeMinion = TributeMinion;
    });

    it("allows external tribute minion to submit share proposal in exchange for tokens", async () => {
      expect(await weth.balanceOf(await gnosisSafe.getAddress())).to.equal(0);
      expect(await weth.balanceOf(users.applicant.address)).to.equal(BigInt(1000));

      await users.applicant.weth?.approve(await tributeMinion.getAddress(), 10000);

      const currentShares = await sharesToken.balanceOf(users.applicant.address);

      users.applicant.tributeMinion && await proposalHelpers.submitAndProcessTributeProposal({
        tributeMinion: users.applicant.tributeMinion,
        baal,
        applicantAddress: users.applicant.address,
        tributeToken: await weth.getAddress(),
        tribute,
        requestedShares,
        requestedLoot,
        proposalOffering: daoConfig.PROPOSAL_OFFERING
      });

      expect(await sharesToken.balanceOf(users.applicant.address)).to.equal(
        requestedShares + currentShares
      );
      expect(await weth.balanceOf(await gnosisSafe.getAddress())).to.equal(tribute);
    });

    // tribute proposal can not self sponsor because of potential tx.origin issues
    // it("should not fail to tribute without offering", async () => {
    //   const currentShares = await sharesToken.balanceOf(users.summoner.address);
    //   // CONDITION: Member should be able to self-sponsor if shares >= SPONSOR_THRESHOLD
    //   expect(currentShares.gte(BigInt(daoConfig.SPONSOR_THRESHOLD)));

    //   // const summonerTributeMinion = tributeMinion.connect(summoner);
    //   // const requestedShares = 1234;
    //   // const tribute = 1000;
    //   // const tributeToken = weth.connect(summoner);

    //   expect(await weth.balanceOf(await gnosisSafe.getAddress())).to.equal(0);
    //   expect(await weth.balanceOf(users.summoner.address)).to.gte(tribute);

    //   await users.summoner.weth?.approve(await tributeMinion.getAddress(), tribute);

    //   users.summoner.tributeMinion && await proposalHelpers.submitAndProcessTributeProposal({
    //     tributeMinion: users.summoner.tributeMinion,
    //     baal,
    //     applicantAddress: users.summoner.address,
    //     tributeToken: await weth.getAddress(),
    //     tribute,
    //     requestedShares,
    //     requestedLoot,
    //     // proposalOffering: daoConfig.PROPOSAL_OFFERING
    //   });

    //   expect(await sharesToken.balanceOf(users.summoner.address))
    //     .to.eq(
    //       currentShares.add(BigInt(requestedShares)),
    //     );
    // });

    it("fails to tribute without offering", async () => {
      const currentShares = await sharesToken.balanceOf(users.applicant.address);
      // CONDITION: Member should send tribute if shares < SPONSOR_THRESHOLD
      expect(currentShares < BigInt(daoConfig.SPONSOR_THRESHOLD));

      expect(await weth.balanceOf(await gnosisSafe.getAddress())).to.equal(0);
      expect(await weth.balanceOf(users.applicant.address)).to.equal(1000);

      await users.applicant.weth?.approve(await tributeMinion.getAddress(), 10000);

      users.applicant.tributeMinion && await expect(users.applicant.tributeMinion.submitTributeProposal(
        await baal.getAddress(),
        await weth.getAddress(),
        tribute,
        requestedShares,
        requestedLoot,
        defaultProposalSettings.EXPIRATION,
        defaultProposalSettings.BAAL_GAS,
        "tribute"
      )).to.be.revertedWith(revertMessages.submitProposalOffering);   
    });
  });
});
