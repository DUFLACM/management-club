/**
 * 组队（报名管理办法第十五条）：超时未组队的三人队按“均衡分组矩阵法”：
 * 入围队员按排序由高到低依次填入三行矩阵，再按列成队。
 * 排序 1..9 → 矩阵 [1,2,3]/[4,5,6]/[7,8,9] → 队伍 (1,4,7)(2,5,8)(3,6,9)。
 * 不擅自改为蛇形分组；其他人数/人工调整须事前定义并审批。
 */

export interface MatrixTeamAssignmentInput<T> {
  /** 已按排序由高到低排列的入围队员 */
  orderedMembers: T[]
  /** 每队人数（制度矩阵为 3）；人数非 3 的倍数时保留余数队列由人工处理 */
  teamSize: number
}

export interface MatrixTeamAssignmentResult<T> {
  teams: T[][]
  /** 无法整除进入矩阵的余量（提示人工调整，不硬套矩阵） */
  remainder: T[]
}

export function matrixTeamAssignment<T>(input: MatrixTeamAssignmentInput<T>): MatrixTeamAssignmentResult<T> {
  const { orderedMembers, teamSize } = input
  if (teamSize !== 3) {
    // 制度口径为三人队矩阵；其他队伍人数必须事前定义并审批，此处不自动创造规则
    return { teams: [], remainder: [...orderedMembers] }
  }
  const rows = Math.ceil(orderedMembers.length / teamSize)
  const matrix: T[][] = Array.from({ length: rows }, () => [])
  for (let i = 0; i < orderedMembers.length; i++) {
    matrix[Math.floor(i / teamSize)].push(orderedMembers[i])
  }
  const lastRowSize = orderedMembers.length % teamSize
  const complete = lastRowSize === 0 ? rows : rows - 1
  const teams: T[][] = []
  for (let col = 0; col < teamSize; col++) {
    const team: T[] = []
    for (let row = 0; row < complete; row++) {
      team.push(matrix[row][col])
    }
    if (team.length > 0) teams.push(team)
  }
  const remainder = lastRowSize === 0 ? [] : matrix[rows - 1]
  return { teams, remainder }
}
