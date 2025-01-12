import { CACHE_MANAGER } from '@nestjs/cache-manager'
import { Inject, Injectable } from '@nestjs/common'
import { Role, type UserGroup } from '@prisma/client'
import { Cache } from 'cache-manager'
import { invitationCodeKey, joinGroupCacheKey } from '@libs/cache'
import { JOIN_GROUP_REQUEST_EXPIRE_TIME, OPEN_SPACE_ID } from '@libs/constants'
import {
  ConflictFoundException,
  EntityNotExistException,
  ForbiddenAccessException
} from '@libs/exception'
import { PrismaService } from '@libs/prisma'
import type { UserGroupData } from './interface/user-group-data.interface'

@Injectable()
export class GroupService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache
  ) {}

  async getGroup(groupId: number, userId: number, invited = false) {
    const isJoined = await this.prisma.userGroup.findFirst({
      where: {
        userId: userId,
        groupId: groupId
      },
      select: {
        group: {
          select: {
            id: true,
            groupName: true,
            description: true
          }
        },
        isGroupLeader: true
      }
    })

    if (!isJoined) {
      const filter = invited ? 'allowJoinFromURL' : 'showOnList'
      const group = await this.prisma.group.findUniqueOrThrow({
        where: {
          id: groupId,
          config: {
            path: [filter],
            equals: true
          }
        },
        select: {
          id: true,
          groupName: true,
          description: true,
          userGroup: true,
          config: true
        }
      })

      return {
        id: group.id,
        groupName: group.groupName,
        description: group.description,
        allowJoin: invited ? true : group.config['allowJoinFromSearch'],
        memberNum: group.userGroup.length,
        leaders: await this.getGroupLeaders(groupId),
        isJoined: false
      }
    } else {
      return {
        ...isJoined.group,
        isGroupLeader: isJoined.isGroupLeader,
        isJoined: true
      }
    }
  }

  async getGroupByInvitation(code: string, userId: number) {
    const groupId: number = await this.cacheManager.get(invitationCodeKey(code))

    if (!groupId) {
      throw new EntityNotExistException('Invalid invitation')
    }
    return this.getGroup(groupId, userId, true)
  }

  async getGroupLeaders(groupId: number): Promise<string[]> {
    const leaders = (
      await this.prisma.userGroup.findMany({
        where: {
          groupId: groupId,
          isGroupLeader: true
        },
        select: {
          user: {
            select: {
              username: true
            }
          }
        }
      })
    ).map((leader) => leader.user.username)

    return leaders
  }

  async getGroupMembers(groupId: number): Promise<string[]> {
    const members = (
      await this.prisma.userGroup.findMany({
        where: {
          groupId: groupId,
          isGroupLeader: false
        },
        select: {
          user: {
            select: {
              username: true
            }
          }
        }
      })
    ).map((member) => member.user.username)

    return members
  }

  async getGroups(cursor: number, take: number) {
    const groups = (
      await this.prisma.group.findMany({
        take,
        skip: cursor ? 1 : 0,
        ...(cursor && { cursor: { id: cursor } }),
        where: {
          NOT: {
            id: 1
          },
          config: {
            path: ['showOnList'],
            equals: true
          }
        },
        select: {
          id: true,
          groupName: true,
          description: true,
          userGroup: true
        }
      })
    ).map((group) => {
      return {
        id: group.id,
        groupName: group.groupName,
        description: group.description,
        memberNum: group.userGroup.length
      }
    })

    return groups
  }

  async getJoinedGroups(userId: number) {
    return (
      await this.prisma.userGroup.findMany({
        where: {
          NOT: {
            groupId: 1
          },
          userId: userId
        },
        select: {
          group: {
            select: {
              id: true,
              groupName: true,
              description: true,
              userGroup: true
            }
          },
          isGroupLeader: true
        }
      })
    ).map((userGroup) => {
      return {
        id: userGroup.group.id,
        groupName: userGroup.group.groupName,
        description: userGroup.group.description,
        memberNum: userGroup.group.userGroup.length,
        isGroupLeader: userGroup.isGroupLeader
      }
    })
  }

  async joinGroupById(
    userId: number,
    groupId: number,
    invitation?: string
  ): Promise<{ userGroupData: Partial<UserGroup>; isJoined: boolean }> {
    if (invitation) {
      const invitedGroupId = await this.cacheManager.get<number>(
        invitationCodeKey(invitation)
      )
      if (!invitedGroupId || groupId !== invitedGroupId) {
        throw new ForbiddenAccessException('Invalid invitation')
      }
    }

    const filter = invitation ? 'allowJoinFromURL' : 'allowJoinFromSearch'
    const group = await this.prisma.group.findUniqueOrThrow({
      where: {
        id: groupId,
        config: {
          path: [filter],
          equals: true
        }
      },
      select: {
        config: true,
        userGroup: {
          select: {
            userId: true
          }
        }
      }
    })

    const isJoined = group.userGroup.some(
      (joinedUser) => joinedUser.userId === userId
    )

    if (isJoined) {
      throw new ConflictFoundException('Already joined this group')
    } else if (group.config['requireApprovalBeforeJoin']) {
      let joinGroupRequest: [number, number][] = await this.cacheManager.get(
        joinGroupCacheKey(groupId)
      )
      if (joinGroupRequest) {
        joinGroupRequest = joinGroupRequest.filter((e) => e[1] > Date.now())
        if (joinGroupRequest.find((e) => e[0] === userId)) {
          throw new ConflictFoundException(
            'Already requested to join this group'
          )
        }
      }

      const requestPair: [number, number] = [
        userId,
        Date.now() + JOIN_GROUP_REQUEST_EXPIRE_TIME
      ]
      if (joinGroupRequest !== undefined) joinGroupRequest.push(requestPair)
      else joinGroupRequest = [requestPair]
      await this.cacheManager.set(
        joinGroupCacheKey(groupId),
        joinGroupRequest,
        JOIN_GROUP_REQUEST_EXPIRE_TIME
      )

      return {
        userGroupData: {
          userId: userId,
          groupId: groupId
        },
        isJoined: false
      }
    } else {
      const userGroupData: UserGroupData = {
        userId,
        groupId,
        isGroupLeader: false
      }
      return {
        userGroupData: await this.createUserGroup(userGroupData),
        isJoined: true
      }
    }
  }

  async leaveGroup(userId: number, groupId: number): Promise<UserGroup> {
    const groupLeaders = await this.prisma.userGroup.findMany({
      where: {
        isGroupLeader: true,
        groupId: groupId
      }
    })
    if (groupLeaders.length == 1 && groupLeaders[0].userId == userId) {
      throw new ConflictFoundException('One or more managers are required')
    }

    const deletedUserGroup = await this.prisma.userGroup.delete({
      where: {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        userId_groupId: {
          userId: userId,
          groupId: groupId
        }
      }
    })
    return deletedUserGroup
  }

  async getUserGroupLeaderList(userId: number): Promise<number[]> {
    return (
      await this.prisma.userGroup.findMany({
        where: {
          userId: userId,
          isGroupLeader: true
        },
        select: {
          groupId: true
        }
      })
    ).map((group) => group.groupId)
  }

  async createUserGroup(userGroupData: UserGroupData): Promise<UserGroup> {
    const user = await this.prisma.user.findUnique({
      where: {
        id: userGroupData.userId
      }
    })

    if (
      user &&
      (user.role === Role.SuperAdmin || user.role === Role.Admin) &&
      userGroupData.groupId != OPEN_SPACE_ID
    ) {
      userGroupData.isGroupLeader = true
    }

    return await this.prisma.userGroup.create({
      data: {
        user: {
          connect: { id: userGroupData.userId }
        },
        group: {
          connect: { id: userGroupData.groupId }
        },
        isGroupLeader: userGroupData.isGroupLeader
      }
    })
  }
}
