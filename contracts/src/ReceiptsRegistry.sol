// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title ReceiptsRegistry
/// @notice Append-only Merkle roots with contract-assigned sequential batch ids.
/// @dev No cadence, leaf provenance or off-chain payload validation is enforced here.
///      The committer can append arbitrary nonempty roots; the owner can rotate or disable it.
///      Inherited Ownable2Step exposes owner(), pendingOwner(), transferOwnership(),
///      acceptOwnership() and renounceOwnership(). Transfer requires pending-owner acceptance;
///      renunciation clears both owners and permanently removes rotation authority.
///      See SECURITY.md privileged powers 1-7 and docs/security/INVARIANTS.md registry rows.
/// @custom:ownership-reads owner() returns the current owner and pendingOwner() returns the
///      proposed owner (initially zero); both are unrestricted reads with no parameters.
/// @custom:ownership-transfer transferOwnership(newOwner) starts/replaces a pending transfer;
///      newOwner may be zero to cancel. Only the current owner may call, otherwise
///      OwnableUnauthorizedAccount(account) identifies the rejected caller. No value is returned.
/// @custom:ownership-accept acceptOwnership() requires the pending owner as caller, otherwise
///      OwnableUnauthorizedAccount(account) identifies the caller. It clears pending ownership,
///      assigns the caller and returns no value. It takes no parameters.
/// @custom:ownership-renounce renounceOwnership() requires the current owner, otherwise
///      OwnableUnauthorizedAccount(account) identifies the caller. It clears current/pending
///      ownership permanently; it takes no parameters and returns no value.
/// @custom:ownership-events OwnershipTransferStarted(previousOwner,newOwner) reports the current
///      owner and proposed owner, including zero for cancellation. OwnershipTransferred(previousOwner,
///      newOwner) reports completed assignment on construction, acceptance or renunciation.
///      Both addresses in each inherited event are indexed; no delay is enforced.
/// @custom:ownership-errors OwnableUnauthorizedAccount(account) reports a rejected privileged
///      caller. OwnableInvalidOwner(owner) rejects a zero initial owner during construction;
///      the effective two-step transfer override permits zero as a pending-transfer cancellation.
contract ReceiptsRegistry is Ownable2Step {
    struct Batch { bytes32 root; uint32 leafCount; uint64 committedAt; address committer; }

    /// @notice Read the address currently authorized to append batches.
    /// @dev Zero disables commits by ordinary callers; reading requires no authorization.
    address public committer;
    /// @notice Read the newest assigned batch id, or zero before the first commit.
    /// @dev Incremented once per successful commit; reading requires no authorization.
    uint64 public lastBatchId;                            // sequence number of the newest batch; the first is 1
    mapping(uint64 => Batch) private _batches;

    /// @notice Emitted on construction and each owner-authorized committer replacement.
    /// @dev Existing batches retain their original committer; zero next disables new commits.
    /// @param previous Prior committer, or zero during construction.
    /// @param next Newly assigned committer, which may be zero.
    event CommitterChanged(address indexed previous, address indexed next);
    /// @notice Emitted after storing a nonempty batch at its new sequential id.
    /// @dev A commit authenticates the caller, not the truth or availability of its leaves.
    /// @param batchId Contract-assigned id starting at one.
    /// @param root Supplied nonzero Merkle root.
    /// @param leafCount Supplied nonzero count; individual leaves are not inspected.
    /// @param committer Caller authorized when this batch was appended.
    event BatchCommitted(uint64 indexed batchId, bytes32 indexed root, uint32 leafCount, address indexed committer);

    /// @notice The commit caller is not the currently configured committer.
    /// @dev Raised before checking the root or leaf count; no state is appended.
    error NotCommitter();
    /// @notice The supplied root is zero or the supplied leaf count is zero.
    /// @dev Raised after caller authorization and before allocating a batch id.
    error EmptyBatch();

    /// @notice Assign the initial owner and committer and emit the initial role change.
    /// @dev Ownable rejects a zero owner with OwnableInvalidOwner; the committer may be zero
    ///      or equal to the owner. The deployment script separately rejects those role choices.
    /// @param owner_ Initial ownership authority, not implicitly the deployment sender.
    /// @param committer_ Initial append authority; zero disables commits.
    constructor(address owner_, address committer_) Ownable(owner_) {
        committer = committer_;
        emit CommitterChanged(address(0), committer_);
    }

    /// @notice Append a root and count and return its newly assigned id.
    /// @dev Only the current committer may call. NotCommitter rejects other callers;
    ///      EmptyBatch rejects zero root/count. Checked uint64 overflow also reverts.
    ///      Stored batches cannot be edited; timestamp is block.timestamp cast to uint64.
    /// @param root Nonzero root built by the off-chain producer.
    /// @param leafCount Nonzero reported leaf count; not recomputed by this contract.
    /// @return batchId Sequential id also emitted in BatchCommitted.
    function commit(bytes32 root, uint32 leafCount) external returns (uint64 batchId) {
        if (msg.sender != committer) revert NotCommitter();
        if (root == bytes32(0) || leafCount == 0) revert EmptyBatch();
        batchId = ++lastBatchId;                          // never overwrites, never goes backwards, never skips
        _batches[batchId] = Batch(root, leafCount, uint64(block.timestamp), msg.sender);
        emit BatchCommitted(batchId, root, leafCount, msg.sender);
    }

    /// @notice Replace or disable the current committer.
    /// @dev Only the owner may call; other callers revert with OwnableUnauthorizedAccount.
    ///      Takes effect immediately and does not change existing batches or user trading.
    /// @param next New committer; zero disables commits and the current address is permitted.
    function setCommitter(address next) external onlyOwner {
        emit CommitterChanged(committer, next);
        committer = next;
    }

    /// @notice Read a stored batch without caller authorization.
    /// @dev An unassigned id returns a zero-initialized Batch rather than reverting.
    /// @param batchId Id to read; zero is never assigned by commit.
    /// @return Stored root, reported count, commit timestamp and original committer.
    function batch(uint64 batchId) external view returns (Batch memory) {
        return _batches[batchId];
    }

    /// @notice Anyone can check a leaf against a committed root.
    /// @dev Returns false for an unassigned batch or a nonmatching sorted-pair Merkle proof.
    ///      Does not validate payload content, leaf index or the reported leaf count.
    /// @param batchId Id of the batch whose root is used.
    /// @param leaf Already encoded leaf hash (off-chain encoding is the caller's responsibility).
    /// @param proof Sibling hashes ordered from the leaf toward the root.
    /// @return Whether the proof resolves to this batch's nonzero stored root.
    function verify(uint64 batchId, bytes32 leaf, bytes32[] calldata proof) external view returns (bool) {
        bytes32 root = _batches[batchId].root;
        return root != bytes32(0) && MerkleProof.verifyCalldata(proof, root, leaf);
    }
}
