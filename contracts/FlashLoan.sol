// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import {CErc20} from "./compound/CErc20.sol";
import {FlashLoanReceiverBase, ILendingPoolAddressesProvider} from "./aave-v2/FlashLoanReceiverBase.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeMath} from "@openzeppelin/contracts/utils/math/SafeMath.sol";

import "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import "@uniswap/v3-periphery/contracts/libraries/TransferHelper.sol";

// Uncomment this line to use console.log
import "hardhat/console.sol";

contract FlashLoan is FlashLoanReceiverBase {
    address public owner;
    address constant UNI_ADDRESS = 0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984;
    address constant USDC_ADDRESS = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    ISwapRouter public immutable swapRouter;

    using SafeMath for uint256;

    constructor(
        ILendingPoolAddressesProvider _addressProvider,
        ISwapRouter _swapRouter
    ) FlashLoanReceiverBase(_addressProvider) {
        owner = msg.sender;
        swapRouter = _swapRouter;
    }

    function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        {
            (
                address _cTokenAddress,
                address _cTokenCollateral,
                address _borrower,
            ) = abi.decode(params, (address, address, address, address));

            // liquidate
            IERC20(assets[0]).approve(_cTokenAddress, amounts[0]);
            uint256 errorCode = CErc20(_cTokenAddress).liquidateBorrow(
                _borrower,
                amounts[0],
                CErc20(_cTokenCollateral)
            );
            require(errorCode == 0, "liquidateBorrow failed");
        }

        {
            (, address _cTokenCollateral, , ) = abi.decode(
                params,
                (address, address, address, address)
            );

            // redeem cToken
            uint256 redeemErc20Token = IERC20(_cTokenCollateral).balanceOf(
                address(this)
            );
            CErc20(_cTokenCollateral).redeem(redeemErc20Token);
        }

        {
            // seize ERC20 token
            uint256 seizeTokenAmount = IERC20(UNI_ADDRESS).balanceOf(
                address(this)
            );
            TransferHelper.safeApprove(
                UNI_ADDRESS,
                address(swapRouter),
                seizeTokenAmount
            );

            ISwapRouter.ExactInputSingleParams memory swapParams = ISwapRouter
                .ExactInputSingleParams({
                    tokenIn: UNI_ADDRESS,
                    tokenOut: USDC_ADDRESS,
                    fee: 3000, // 0.3%
                    recipient: address(this),
                    deadline: block.timestamp,
                    amountIn: seizeTokenAmount,
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0
                });

            // The call to `exactInputSingle` executes the swap.
            uint256 amountOut = swapRouter.exactInputSingle(swapParams);

            // Approve the LendingPool contract allowance to *pull* the owed amount
            uint256 amountOwing = amounts[0].add(premiums[0]);
            IERC20(assets[0]).approve(address(LENDING_POOL), amountOwing); // payback to AAVE

            (, , , address _liquidator) = abi.decode(
                params,
                (address, address, address, address)
            );
            IERC20(assets[0]).transfer(_liquidator, amountOut - amountOwing); // transfer USDC to _liquidator
        }

        return true;
    }

    function flashloan(
        address _asset,
        uint256 _amount,
        bytes memory _params
    ) external {
        require(msg.sender == owner, "not authorized");
        
        address receiverAddress = address(this);

        address[] memory assets = new address[](1);
        assets[0] = _asset; // USDC

        uint256[] memory amounts = new uint256[](1);
        amounts[0] = _amount;

        // 0 = no debt, 1 = stable, 2 = variable
        uint256[] memory modes = new uint256[](1);
        modes[0] = 0;

        address onBehalfOf = address(this);

        uint16 referralCode = 0;

        LENDING_POOL.flashLoan(
            receiverAddress,
            assets,
            amounts,
            modes,
            onBehalfOf,
            _params,
            referralCode
        );
    }
}
