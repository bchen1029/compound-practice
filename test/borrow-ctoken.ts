import { loadFixture } from "@nomicfoundation/hardhat-network-helpers"
import { expect } from "chai"
import { ethers } from "hardhat"

describe("compound", function () {
  // We define a fixture to reuse the same setup in every test.
  // We use loadFixture to run this setup once, snapshot that state,
  // and reset Hardhat Network to that snapshot in every test.
  async function deployFixture() {
    const TOKEN_A_INITIAL_SUPPLY = ethers.utils.parseUnits("10000", "18")
    const TOKEN_B_INITIAL_SUPPLY = ethers.utils.parseUnits("10000", "18")

    // Contracts are deployed using the first signer/account by default
    const [owner] = await ethers.getSigners()

    // Comptroller
    const ComptrollerContract = await ethers.getContractFactory("Comptroller")
    const comptroller = await ComptrollerContract.deploy()
    await comptroller.deployed()

    // SimplePriceOracle
    const SimplePriceOracleContract = await ethers.getContractFactory(
      "SimplePriceOracle"
    )
    const simplePriceOracle = await SimplePriceOracleContract.deploy()
    await simplePriceOracle.deployed()

    // InterestRateModel, use WhitePaperInterestRateModel here
    const InterestRateModelContract = await ethers.getContractFactory(
      "WhitePaperInterestRateModel"
    )
    const interestRateModel = await InterestRateModelContract.deploy(0, 0)
    await interestRateModel.deployed()

    // TokenA: underlying ERC20
    const TokenAContract = await ethers.getContractFactory("SmartBruceToken")
    const tokenA = await TokenAContract.deploy(TOKEN_A_INITIAL_SUPPLY)
    await tokenA.deployed()

    // TokenB: underlying ERC20
    const TokenBContract = await ethers.getContractFactory(
      "FoolishBruceToken"
    )
    const tokenB = await TokenBContract.deploy(TOKEN_B_INITIAL_SUPPLY)
    await tokenB.deployed()

    // CTokenA: CErc20 using CErc20Immutable
    const CTokenAContract = await ethers.getContractFactory(
      "CErc20Immutable"
    )
    const cTokenA = await CTokenAContract.deploy(
      tokenA.address,
      comptroller.address,
      interestRateModel.address,
      ethers.utils.parseUnits("1", "18"),
      "CSmartBruceToken",
      "CSBT",
      18,
      owner.address
    )
    await cTokenA.deployed()

    // CTokenB: CErc20 using CErc20Immutable
    const CTokenBContract = await ethers.getContractFactory(
      "CErc20Immutable"
    )
    const cTokenB = await CTokenBContract.deploy(
      tokenB.address,
      comptroller.address,
      interestRateModel.address,
      ethers.utils.parseUnits("1", "18"),
      "CFoolishBruceToken",
      "CFBT",
      18,
      owner.address
    )
    await cTokenB.deployed()

    return {
      comptroller,
      simplePriceOracle,
      interestRateModel,
      tokenA,
      tokenB,
      cTokenA,
      cTokenB,
    }
  }

  async function initSettingFixture() {
    const USER1_INITAL_TOKEN_B_BALANCE = ethers.utils.parseUnits("1", "18")
    const USER2_INITAL_TOKEN_A_BALANCE = ethers.utils.parseUnits("150", "18")

    const [owner, user1, user2] = await ethers.getSigners()
    const deployResult = await loadFixture(deployFixture)
    const {
      comptroller,
      simplePriceOracle,
      cTokenA,
      cTokenB,
      tokenA,
      tokenB
    } = deployResult

    // _setPriceOracle, 設定新的 price oracle
    await comptroller._setPriceOracle(simplePriceOracle.address)

    // 設定 oracle 價格
    await simplePriceOracle.setUnderlyingPrice(
      cTokenA.address,
      ethers.utils.parseUnits("1", 18)
    )
    await simplePriceOracle.setUnderlyingPrice(
      cTokenB.address,
      ethers.utils.parseUnits("100", "18")
    )

    // _supportMarket, 把 cToken 新增到 comptroller 的 markets
    await comptroller._supportMarket(cTokenA.address)
    await comptroller._supportMarket(cTokenB.address)

    // _setCollateralFactor, 設定 tokenB 的 collateral factor
    await comptroller._setCollateralFactor(
      cTokenB.address,
      ethers.utils.parseUnits("0.5", "18")
    )

    // _setCloseFactor, 設定 close factor 最多可以幫被清償人還多少 token 
    await comptroller._setCloseFactor(ethers.utils.parseUnits("0.5", "18"))

    // _setLiquidationIncentive, 設定清償人獎勵
    await comptroller._setLiquidationIncentive(ethers.utils.parseUnits("0.08", "18"))

    // enterMarkets, 為 tokenA tokenB 提供流動性
    await comptroller.connect(user1).enterMarkets([cTokenA.address, cTokenB.address])
    await comptroller.connect(user2).enterMarkets([cTokenA.address, cTokenB.address])

    // initial send 1 TokenB tokens to user1
    await tokenB.transfer(user1.address, USER1_INITAL_TOKEN_B_BALANCE)

    // initial send 150 TokenA tokens to user2
    await tokenA.transfer(user2.address, USER2_INITAL_TOKEN_A_BALANCE)

    return {
      ...deployResult
    }
  }

  async function borrowFixture() {
    const USER1_MINT_TOKEN_B_AMOUNT = ethers.utils.parseUnits("1", "18")
    const USER2_MINT_TOKEN_A_AMOUNT = ethers.utils.parseUnits("50", "18")

    const fixtureResult = await loadFixture(initSettingFixture)
    const [owner, user1, user2] = await ethers.getSigners()
    const { tokenB, cTokenB, tokenA, cTokenA } = fixtureResult


    // user1 mint 1 cTokenB
    await tokenB.connect(user1).approve(cTokenB.address, USER1_MINT_TOKEN_B_AMOUNT)
    await cTokenB.connect(user1).mint(USER1_MINT_TOKEN_B_AMOUNT)


    // user2 mint 50 cTokenA
    await tokenA.connect(user2).approve(cTokenA.address, USER2_MINT_TOKEN_A_AMOUNT)
    await cTokenA.connect(user2).mint(USER2_MINT_TOKEN_A_AMOUNT)

    // user1 borrow 50 TokenA with 1 tokenB as collateral
    await cTokenA.connect(user1).borrow(ethers.utils.parseUnits("50", "18"))

    return {
      ...fixtureResult
    }
  }

  describe("Deployment", function () {
    it("Should user1 owns 1 tokenB", async function () {
      const [owner, user1, user2] = await ethers.getSigners()
      const { tokenB } = await loadFixture(initSettingFixture)

      expect(await tokenB.balanceOf(user1.address)).to.equal(ethers.utils.parseUnits("1", "18"))
    })

    it("Should user2 owns 150 tokenA", async function () {
      const [owner, user1, user2] = await ethers.getSigners()
      const { tokenA } = await loadFixture(initSettingFixture)

      expect(await tokenA.balanceOf(user2.address)).to.equal(ethers.utils.parseUnits("150", "18"))
    })

    it("Should comptroller oracle is simplePriceOracle", async function () {
      const { comptroller, simplePriceOracle } = await loadFixture(initSettingFixture)

      expect(await comptroller.oracle()).to.equal(simplePriceOracle.address)
    })

    it("Should tokenA price is $1 USD", async function () {
      const { simplePriceOracle, cTokenA } = await loadFixture(initSettingFixture)

      expect(await simplePriceOracle.getUnderlyingPrice(cTokenA.address)).to.equal(ethers.utils.parseUnits("1", "18"))
    })

    it("Should tokenB price is $100 USD", async function () {
      const { simplePriceOracle, cTokenB } = await loadFixture(initSettingFixture)

      expect(await simplePriceOracle.getUnderlyingPrice(cTokenB.address)).to.equal(ethers.utils.parseUnits("100", "18"))
    })

    it("Should tokenA and tokenB are listed on markets", async function () {
      const { comptroller, cTokenA, cTokenB } = await loadFixture(initSettingFixture)

      const marketOfTokenA = await comptroller.markets(cTokenA.address)
      const marketOfTokenB = await comptroller.markets(cTokenB.address)

      expect(marketOfTokenA.isListed).to.equal(true)
      expect(marketOfTokenB.isListed).to.equal(true)
    })

    it("Should collateralFactor of tokenB is 0.5", async function () {
      const { comptroller, cTokenB } = await loadFixture(initSettingFixture)

      const marketOfTokenB = await comptroller.markets(cTokenB.address)

      expect(marketOfTokenB.collateralFactorMantissa).to.equal(ethers.utils.parseUnits("0.5", "18"))
    })

    it("Should liquidationIncentive is 0.08", async function () {
      const { comptroller } = await loadFixture(initSettingFixture)

      expect(await comptroller.liquidationIncentiveMantissa()).to.equal(ethers.utils.parseUnits("0.08", "18"))
    })

    it("Should close factor is 0.5", async function () {
      const { comptroller } = await loadFixture(initSettingFixture)

      expect(await comptroller.closeFactorMantissa()).to.equal(ethers.utils.parseUnits("0.5", "18"))
    })
  })

  describe("Borrow feature", function () {
    it("Should user1 borrow right amount tokenA with 1 tokenB as collateral", async function () {
      const [owner, user1, user2] = await ethers.getSigners()
      const {tokenA} = await loadFixture(borrowFixture)
      
      expect(await tokenA.balanceOf(user1.address)).to.equal(ethers.utils.parseUnits("50", "18"))
    })

    it("Should user1 be liquidated when collateral factor of tokenB decreased from 0.5 to 0.4", async function () {
      const [owner, user1, user2] = await ethers.getSigners()
      const {comptroller, cTokenB, cTokenA, tokenA} = await loadFixture(borrowFixture)

      // decrease tokenB collateral factor from 0.5 to 0.4
      await comptroller._setCollateralFactor(cTokenB.address,
        ethers.utils.parseUnits("0.4", "18")
      )

      // user2 borrow 25 tokenA to user1 for liquidating and seize tokenB collateral
      await tokenA.connect(user2).approve(cTokenA.address, ethers.utils.parseUnits("25", "18"))
      await cTokenA.connect(user2).liquidateBorrow(user1.address, ethers.utils.parseUnits("25", "18"), cTokenB.address)

      expect(await cTokenB.balanceOf(user2.address)).to.above(0) // user2's cTokenB increased because seized user1's collateral
    })

    it("Should user1 liquidated reverte because repayAmount above close factor", async function () {
      const [owner, user1, user2] = await ethers.getSigners()
      const {comptroller, cTokenB, cTokenA, tokenA} = await loadFixture(borrowFixture)

      // decrease tokenB collateral factor from 0.5 to 0.4
      await comptroller._setCollateralFactor(cTokenB.address,
        ethers.utils.parseUnits("0.4", "18")
      )

      // user2 borrow 30 tokenA to user1 for liquidating and seize tokenB collateral
      await tokenA.connect(user2).approve(cTokenA.address, ethers.utils.parseUnits("30", "18"))

      // user2 liquidating would fail because repayAmount maximize is 0.5 * 50
      expect(cTokenA.connect(user2).liquidateBorrow(user1.address, ethers.utils.parseUnits("30", "18"), cTokenB.address)).to.revertedWithCustomError(cTokenA, "LiquidateComptrollerRejection")
    })

    it("Should user1 be liquidated when tokenB depreciated from $100 to $50", async function () {
      const [owner, user1, user2] = await ethers.getSigners()
      const {simplePriceOracle, cTokenB, cTokenA, tokenA} = await loadFixture(borrowFixture)

      // depreciate tokenB price to make user1 can be liquidated
      await simplePriceOracle.setUnderlyingPrice(
        cTokenB.address,
        ethers.utils.parseUnits("50", "18")
      )

      // user2 borrow 25 tokenA to user1 for liquidating and seize tokenB collateral
      await tokenA.connect(user2).approve(cTokenA.address, ethers.utils.parseUnits("25", "18"))
      await cTokenA.connect(user2).liquidateBorrow(user1.address, ethers.utils.parseUnits("25", "18"), cTokenB.address)

      expect(await cTokenB.balanceOf(user2.address)).to.above(0) // user2's cTokenB increased because seized user1's collateral
    })
  })
})